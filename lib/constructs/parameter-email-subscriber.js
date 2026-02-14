"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParameterEmailSubscriber = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const CustomResourceSDK = require("aws-cdk-lib/custom-resources");
const constructs_1 = require("constructs");
const aws_iam = require("aws-cdk-lib/aws-iam");
const aws_lambda = require("aws-cdk-lib/aws-lambda");
const aws_logs = require("aws-cdk-lib/aws-logs");
/**
 * Custom resource that reads email addresses from SSM Parameter Store
 * and subscribes them to an SNS topic.
 *
 * The parameter should contain comma-separated email addresses:
 * email1@example.com,email2@example.com
 *
 * On stack deletion, all subscriptions created by this resource are removed.
 */
class ParameterEmailSubscriber extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { topicArn, parameterName, region } = props;
        const stack = aws_cdk_lib_1.Stack.of(this);
        const effectiveRegion = region || stack.region;
        // Create Lambda function for custom resource handler
        const handler = new aws_lambda.SingletonFunction(this, "EmailSubscriberHandler", {
            uuid: "parameter-email-subscriber-handler",
            runtime: aws_lambda.Runtime.NODEJS_18_X,
            handler: "index.handler",
            code: aws_lambda.Code.fromInline(`
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SNSClient, SubscribeCommand, UnsubscribeCommand, ListSubscriptionsByTopicCommand } = require("@aws-sdk/client-sns");

const ssm = new SSMClient();
const sns = new SNSClient();

async function getEmailsFromParameter(parameterName) {
  try {
    const command = new GetParameterCommand({ Name: parameterName });
    const response = await ssm.send(command);
    const value = response.Parameter?.Value || "";
    
    // Split by comma and trim whitespace
    const emails = value
      .split(",")
      .map(email => email.trim())
      .filter(email => email.length > 0);
    
    console.log(\`Found \${emails.length} email(s) in parameter: \${emails.join(", ")}\`);
    return emails;
  } catch (error) {
    console.error("Error reading parameter:", error);
    throw new Error(\`Failed to read parameter \${parameterName}: \${error.message}\`);
  }
}

async function subscribeEmails(topicArn, emails) {
  const subscriptionArns = [];
  
  for (const email of emails) {
    try {
      const command = new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "email",
        Endpoint: email,
      });
      const response = await sns.send(command);
      console.log(\`Subscribed \${email} to topic. Subscription ARN: \${response.SubscriptionArn}\`);
      subscriptionArns.push(response.SubscriptionArn);
    } catch (error) {
      console.error(\`Error subscribing \${email}:\`, error);
      // Continue with other emails even if one fails
    }
  }
  
  return subscriptionArns;
}

async function unsubscribeEmails(subscriptionArns) {
  for (const arn of subscriptionArns) {
    // Skip pending confirmations (they auto-expire)
    if (arn === "pending confirmation") {
      console.log("Skipping pending confirmation subscription");
      continue;
    }
    
    try {
      const command = new UnsubscribeCommand({ SubscriptionArn: arn });
      await sns.send(command);
      console.log(\`Unsubscribed: \${arn}\`);
    } catch (error) {
      console.error(\`Error unsubscribing \${arn}:\`, error);
    }
  }
}

async function listTopicSubscriptions(topicArn) {
  try {
    const command = new ListSubscriptionsByTopicCommand({ TopicArn: topicArn });
    const response = await sns.send(command);
    return response.Subscriptions || [];
  } catch (error) {
    console.error("Error listing subscriptions:", error);
    return [];
  }
}

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));
  
  const { RequestType, ResourceProperties, PhysicalResourceId } = event;
  const { TopicArn, ParameterName } = ResourceProperties;
  
  try {
    if (RequestType === "Create" || RequestType === "Update") {
      const emails = await getEmailsFromParameter(ParameterName);
      
      if (emails.length === 0) {
        console.warn("No emails found in parameter. No subscriptions created.");
        return {
          PhysicalResourceId: PhysicalResourceId || \`email-subscriber-\${Date.now()}\`,
          Data: {
            SubscriptionCount: 0,
            Emails: "",
          },
        };
      }
      
      const subscriptionArns = await subscribeEmails(TopicArn, emails);
      
      return {
        PhysicalResourceId: PhysicalResourceId || \`email-subscriber-\${Date.now()}\`,
        Data: {
          SubscriptionCount: subscriptionArns.length,
          Emails: emails.join(","),
          SubscriptionArns: subscriptionArns.join(","),
        },
      };
    } else if (RequestType === "Delete") {
      // On deletion, we need to clean up subscriptions
      // Since we can't reliably track which subscriptions we created,
      // we'll list all email subscriptions and remove them
      console.log("Delete request - cleaning up email subscriptions");
      
      const allSubscriptions = await listTopicSubscriptions(TopicArn);
      const emailSubscriptions = allSubscriptions
        .filter(sub => sub.Protocol === "email")
        .map(sub => sub.SubscriptionArn);
      
      console.log(\`Found \${emailSubscriptions.length} email subscription(s) to remove\`);
      await unsubscribeEmails(emailSubscriptions);
      
      return {
        PhysicalResourceId: PhysicalResourceId,
      };
    }
    
    return {
      PhysicalResourceId: PhysicalResourceId || \`email-subscriber-\${Date.now()}\`,
    };
  } catch (error) {
    console.error("Handler error:", error);
    throw error;
  }
};
        `),
            timeout: aws_cdk_lib_1.Duration.minutes(5),
            logRetention: aws_logs.RetentionDays.ONE_WEEK,
        });
        // Grant permissions to read SSM parameter
        handler.addToRolePolicy(new aws_iam.PolicyStatement({
            effect: aws_iam.Effect.ALLOW,
            actions: ["ssm:GetParameter"],
            resources: [
                aws_cdk_lib_1.Arn.format({
                    service: "ssm",
                    region: effectiveRegion,
                    resource: "parameter",
                    resourceName: parameterName.startsWith("/")
                        ? parameterName.slice(1)
                        : parameterName,
                }, stack),
            ],
        }));
        // Grant permissions to manage SNS subscriptions
        handler.addToRolePolicy(new aws_iam.PolicyStatement({
            effect: aws_iam.Effect.ALLOW,
            actions: [
                "sns:Subscribe",
                "sns:Unsubscribe",
                "sns:ListSubscriptionsByTopic",
            ],
            resources: [topicArn],
        }));
        // Create the custom resource
        const provider = new CustomResourceSDK.Provider(this, "EmailSubscriberProvider", {
            onEventHandler: handler,
            logRetention: aws_logs.RetentionDays.ONE_WEEK,
        });
        new aws_cdk_lib_1.CustomResource(this, "EmailSubscriberResource", {
            serviceToken: provider.serviceToken,
            properties: {
                TopicArn: topicArn,
                ParameterName: parameterName,
            },
        });
    }
}
exports.ParameterEmailSubscriber = ParameterEmailSubscriber;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYW1ldGVyLWVtYWlsLXN1YnNjcmliZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXJhbWV0ZXItZW1haWwtc3Vic2NyaWJlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw2Q0FBbUU7QUFDbkUsa0VBQWtFO0FBQ2xFLDJDQUF1QztBQUN2QywrQ0FBK0M7QUFDL0MscURBQXFEO0FBQ3JELGlEQUFpRDtBQXFCakQ7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFhLHdCQUF5QixTQUFRLHNCQUFTO0lBQ3JELFlBQ0UsS0FBZ0IsRUFDaEIsRUFBVSxFQUNWLEtBQW9DO1FBRXBDLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUFFLFFBQVEsRUFBRSxhQUFhLEVBQUUsTUFBTSxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQ2xELE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzdCLE1BQU0sZUFBZSxHQUFHLE1BQU0sSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDO1FBRS9DLHFEQUFxRDtRQUNyRCxNQUFNLE9BQU8sR0FBRyxJQUFJLFVBQVUsQ0FBQyxpQkFBaUIsQ0FDOUMsSUFBSSxFQUNKLHdCQUF3QixFQUN4QjtZQUNFLElBQUksRUFBRSxvQ0FBb0M7WUFDMUMsT0FBTyxFQUFFLFVBQVUsQ0FBQyxPQUFPLENBQUMsV0FBVztZQUN2QyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsVUFBVSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7U0F3SWhDLENBQUM7WUFDRixPQUFPLEVBQUUsc0JBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1lBQzVCLFlBQVksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLFFBQVE7U0FDOUMsQ0FDRixDQUFDO1FBRUYsMENBQTBDO1FBQzFDLE9BQU8sQ0FBQyxlQUFlLENBQ3JCLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQztZQUMxQixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQzVCLE9BQU8sRUFBRSxDQUFDLGtCQUFrQixDQUFDO1lBQzdCLFNBQVMsRUFBRTtnQkFDVCxpQkFBRyxDQUFDLE1BQU0sQ0FDUjtvQkFDRSxPQUFPLEVBQUUsS0FBSztvQkFDZCxNQUFNLEVBQUUsZUFBZTtvQkFDdkIsUUFBUSxFQUFFLFdBQVc7b0JBQ3JCLFlBQVksRUFBRSxhQUFhLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQzt3QkFDekMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO3dCQUN4QixDQUFDLENBQUMsYUFBYTtpQkFDbEIsRUFDRCxLQUFLLENBQ047YUFDRjtTQUNGLENBQUMsQ0FDSCxDQUFDO1FBRUYsZ0RBQWdEO1FBQ2hELE9BQU8sQ0FBQyxlQUFlLENBQ3JCLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQztZQUMxQixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQzVCLE9BQU8sRUFBRTtnQkFDUCxlQUFlO2dCQUNmLGlCQUFpQjtnQkFDakIsOEJBQThCO2FBQy9CO1lBQ0QsU0FBUyxFQUFFLENBQUMsUUFBUSxDQUFDO1NBQ3RCLENBQUMsQ0FDSCxDQUFDO1FBRUYsNkJBQTZCO1FBQzdCLE1BQU0sUUFBUSxHQUFHLElBQUksaUJBQWlCLENBQUMsUUFBUSxDQUM3QyxJQUFJLEVBQ0oseUJBQXlCLEVBQ3pCO1lBQ0UsY0FBYyxFQUFFLE9BQU87WUFDdkIsWUFBWSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsUUFBUTtTQUM5QyxDQUNGLENBQUM7UUFFRixJQUFJLDRCQUFjLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ2xELFlBQVksRUFBRSxRQUFRLENBQUMsWUFBWTtZQUNuQyxVQUFVLEVBQUU7Z0JBQ1YsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLGFBQWEsRUFBRSxhQUFhO2FBQzdCO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBdE5ELDREQXNOQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEFybiwgU3RhY2ssIEN1c3RvbVJlc291cmNlLCBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgQ3VzdG9tUmVzb3VyY2VTREsgZnJvbSBcImF3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBhd3NfaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBhd3NfbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBhd3NfbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcInBhdGhcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQYXJhbWV0ZXJFbWFpbFN1YnNjcmliZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBBUk4gb2YgdGhlIFNOUyB0b3BpYyB0byBzdWJzY3JpYmUgZW1haWxzIHRvXG4gICAqL1xuICB0b3BpY0Fybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGdWxsIHBhdGggdG8gdGhlIFNTTSBQYXJhbWV0ZXIgY29udGFpbmluZyBjb21tYS1zZXBhcmF0ZWQgZW1haWwgYWRkcmVzc2VzXG4gICAqIEV4YW1wbGU6IC9nbG9iYWwtYXBwLXBhcmFtcy9yZHNub3RpZmljYXRpb25lbWFpbHNcbiAgICovXG4gIHBhcmFtZXRlck5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogUmVnaW9uIHdoZXJlIHRoZSBwYXJhbWV0ZXIgaXMgc3RvcmVkIChkZWZhdWx0OiBjdXJyZW50IHJlZ2lvbilcbiAgICovXG4gIHJlZ2lvbj86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDdXN0b20gcmVzb3VyY2UgdGhhdCByZWFkcyBlbWFpbCBhZGRyZXNzZXMgZnJvbSBTU00gUGFyYW1ldGVyIFN0b3JlXG4gKiBhbmQgc3Vic2NyaWJlcyB0aGVtIHRvIGFuIFNOUyB0b3BpYy5cbiAqIFxuICogVGhlIHBhcmFtZXRlciBzaG91bGQgY29udGFpbiBjb21tYS1zZXBhcmF0ZWQgZW1haWwgYWRkcmVzc2VzOlxuICogZW1haWwxQGV4YW1wbGUuY29tLGVtYWlsMkBleGFtcGxlLmNvbVxuICogXG4gKiBPbiBzdGFjayBkZWxldGlvbiwgYWxsIHN1YnNjcmlwdGlvbnMgY3JlYXRlZCBieSB0aGlzIHJlc291cmNlIGFyZSByZW1vdmVkLlxuICovXG5leHBvcnQgY2xhc3MgUGFyYW1ldGVyRW1haWxTdWJzY3JpYmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgY29uc3RydWN0b3IoXG4gICAgc2NvcGU6IENvbnN0cnVjdCxcbiAgICBpZDogc3RyaW5nLFxuICAgIHByb3BzOiBQYXJhbWV0ZXJFbWFpbFN1YnNjcmliZXJQcm9wc1xuICApIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgeyB0b3BpY0FybiwgcGFyYW1ldGVyTmFtZSwgcmVnaW9uIH0gPSBwcm9wcztcbiAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IGVmZmVjdGl2ZVJlZ2lvbiA9IHJlZ2lvbiB8fCBzdGFjay5yZWdpb247XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGZ1bmN0aW9uIGZvciBjdXN0b20gcmVzb3VyY2UgaGFuZGxlclxuICAgIGNvbnN0IGhhbmRsZXIgPSBuZXcgYXdzX2xhbWJkYS5TaW5nbGV0b25GdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICBcIkVtYWlsU3Vic2NyaWJlckhhbmRsZXJcIixcbiAgICAgIHtcbiAgICAgICAgdXVpZDogXCJwYXJhbWV0ZXItZW1haWwtc3Vic2NyaWJlci1oYW5kbGVyXCIsXG4gICAgICAgIHJ1bnRpbWU6IGF3c19sYW1iZGEuUnVudGltZS5OT0RFSlNfMThfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGF3c19sYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmNvbnN0IHsgU1NNQ2xpZW50LCBHZXRQYXJhbWV0ZXJDb21tYW5kIH0gPSByZXF1aXJlKFwiQGF3cy1zZGsvY2xpZW50LXNzbVwiKTtcbmNvbnN0IHsgU05TQ2xpZW50LCBTdWJzY3JpYmVDb21tYW5kLCBVbnN1YnNjcmliZUNvbW1hbmQsIExpc3RTdWJzY3JpcHRpb25zQnlUb3BpY0NvbW1hbmQgfSA9IHJlcXVpcmUoXCJAYXdzLXNkay9jbGllbnQtc25zXCIpO1xuXG5jb25zdCBzc20gPSBuZXcgU1NNQ2xpZW50KCk7XG5jb25zdCBzbnMgPSBuZXcgU05TQ2xpZW50KCk7XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEVtYWlsc0Zyb21QYXJhbWV0ZXIocGFyYW1ldGVyTmFtZSkge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0UGFyYW1ldGVyQ29tbWFuZCh7IE5hbWU6IHBhcmFtZXRlck5hbWUgfSk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzc20uc2VuZChjb21tYW5kKTtcbiAgICBjb25zdCB2YWx1ZSA9IHJlc3BvbnNlLlBhcmFtZXRlcj8uVmFsdWUgfHwgXCJcIjtcbiAgICBcbiAgICAvLyBTcGxpdCBieSBjb21tYSBhbmQgdHJpbSB3aGl0ZXNwYWNlXG4gICAgY29uc3QgZW1haWxzID0gdmFsdWVcbiAgICAgIC5zcGxpdChcIixcIilcbiAgICAgIC5tYXAoZW1haWwgPT4gZW1haWwudHJpbSgpKVxuICAgICAgLmZpbHRlcihlbWFpbCA9PiBlbWFpbC5sZW5ndGggPiAwKTtcbiAgICBcbiAgICBjb25zb2xlLmxvZyhcXGBGb3VuZCBcXCR7ZW1haWxzLmxlbmd0aH0gZW1haWwocykgaW4gcGFyYW1ldGVyOiBcXCR7ZW1haWxzLmpvaW4oXCIsIFwiKX1cXGApO1xuICAgIHJldHVybiBlbWFpbHM7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihcIkVycm9yIHJlYWRpbmcgcGFyYW1ldGVyOlwiLCBlcnJvcik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxcYEZhaWxlZCB0byByZWFkIHBhcmFtZXRlciBcXCR7cGFyYW1ldGVyTmFtZX06IFxcJHtlcnJvci5tZXNzYWdlfVxcYCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3Vic2NyaWJlRW1haWxzKHRvcGljQXJuLCBlbWFpbHMpIHtcbiAgY29uc3Qgc3Vic2NyaXB0aW9uQXJucyA9IFtdO1xuICBcbiAgZm9yIChjb25zdCBlbWFpbCBvZiBlbWFpbHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY29tbWFuZCA9IG5ldyBTdWJzY3JpYmVDb21tYW5kKHtcbiAgICAgICAgVG9waWNBcm46IHRvcGljQXJuLFxuICAgICAgICBQcm90b2NvbDogXCJlbWFpbFwiLFxuICAgICAgICBFbmRwb2ludDogZW1haWwsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc25zLnNlbmQoY29tbWFuZCk7XG4gICAgICBjb25zb2xlLmxvZyhcXGBTdWJzY3JpYmVkIFxcJHtlbWFpbH0gdG8gdG9waWMuIFN1YnNjcmlwdGlvbiBBUk46IFxcJHtyZXNwb25zZS5TdWJzY3JpcHRpb25Bcm59XFxgKTtcbiAgICAgIHN1YnNjcmlwdGlvbkFybnMucHVzaChyZXNwb25zZS5TdWJzY3JpcHRpb25Bcm4pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFxcYEVycm9yIHN1YnNjcmliaW5nIFxcJHtlbWFpbH06XFxgLCBlcnJvcik7XG4gICAgICAvLyBDb250aW51ZSB3aXRoIG90aGVyIGVtYWlscyBldmVuIGlmIG9uZSBmYWlsc1xuICAgIH1cbiAgfVxuICBcbiAgcmV0dXJuIHN1YnNjcmlwdGlvbkFybnM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVuc3Vic2NyaWJlRW1haWxzKHN1YnNjcmlwdGlvbkFybnMpIHtcbiAgZm9yIChjb25zdCBhcm4gb2Ygc3Vic2NyaXB0aW9uQXJucykge1xuICAgIC8vIFNraXAgcGVuZGluZyBjb25maXJtYXRpb25zICh0aGV5IGF1dG8tZXhwaXJlKVxuICAgIGlmIChhcm4gPT09IFwicGVuZGluZyBjb25maXJtYXRpb25cIikge1xuICAgICAgY29uc29sZS5sb2coXCJTa2lwcGluZyBwZW5kaW5nIGNvbmZpcm1hdGlvbiBzdWJzY3JpcHRpb25cIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgVW5zdWJzY3JpYmVDb21tYW5kKHsgU3Vic2NyaXB0aW9uQXJuOiBhcm4gfSk7XG4gICAgICBhd2FpdCBzbnMuc2VuZChjb21tYW5kKTtcbiAgICAgIGNvbnNvbGUubG9nKFxcYFVuc3Vic2NyaWJlZDogXFwke2Fybn1cXGApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFxcYEVycm9yIHVuc3Vic2NyaWJpbmcgXFwke2Fybn06XFxgLCBlcnJvcik7XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RUb3BpY1N1YnNjcmlwdGlvbnModG9waWNBcm4pIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IExpc3RTdWJzY3JpcHRpb25zQnlUb3BpY0NvbW1hbmQoeyBUb3BpY0FybjogdG9waWNBcm4gfSk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzbnMuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzcG9uc2UuU3Vic2NyaXB0aW9ucyB8fCBbXTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiRXJyb3IgbGlzdGluZyBzdWJzY3JpcHRpb25zOlwiLCBlcnJvcik7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICBjb25zb2xlLmxvZyhcIkV2ZW50OlwiLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuICBcbiAgY29uc3QgeyBSZXF1ZXN0VHlwZSwgUmVzb3VyY2VQcm9wZXJ0aWVzLCBQaHlzaWNhbFJlc291cmNlSWQgfSA9IGV2ZW50O1xuICBjb25zdCB7IFRvcGljQXJuLCBQYXJhbWV0ZXJOYW1lIH0gPSBSZXNvdXJjZVByb3BlcnRpZXM7XG4gIFxuICB0cnkge1xuICAgIGlmIChSZXF1ZXN0VHlwZSA9PT0gXCJDcmVhdGVcIiB8fCBSZXF1ZXN0VHlwZSA9PT0gXCJVcGRhdGVcIikge1xuICAgICAgY29uc3QgZW1haWxzID0gYXdhaXQgZ2V0RW1haWxzRnJvbVBhcmFtZXRlcihQYXJhbWV0ZXJOYW1lKTtcbiAgICAgIFxuICAgICAgaWYgKGVtYWlscy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiTm8gZW1haWxzIGZvdW5kIGluIHBhcmFtZXRlci4gTm8gc3Vic2NyaXB0aW9ucyBjcmVhdGVkLlwiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICAgICAgICBEYXRhOiB7XG4gICAgICAgICAgICBTdWJzY3JpcHRpb25Db3VudDogMCxcbiAgICAgICAgICAgIEVtYWlsczogXCJcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgXG4gICAgICBjb25zdCBzdWJzY3JpcHRpb25Bcm5zID0gYXdhaXQgc3Vic2NyaWJlRW1haWxzKFRvcGljQXJuLCBlbWFpbHMpO1xuICAgICAgXG4gICAgICByZXR1cm4ge1xuICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICAgICAgRGF0YToge1xuICAgICAgICAgIFN1YnNjcmlwdGlvbkNvdW50OiBzdWJzY3JpcHRpb25Bcm5zLmxlbmd0aCxcbiAgICAgICAgICBFbWFpbHM6IGVtYWlscy5qb2luKFwiLFwiKSxcbiAgICAgICAgICBTdWJzY3JpcHRpb25Bcm5zOiBzdWJzY3JpcHRpb25Bcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKFJlcXVlc3RUeXBlID09PSBcIkRlbGV0ZVwiKSB7XG4gICAgICAvLyBPbiBkZWxldGlvbiwgd2UgbmVlZCB0byBjbGVhbiB1cCBzdWJzY3JpcHRpb25zXG4gICAgICAvLyBTaW5jZSB3ZSBjYW4ndCByZWxpYWJseSB0cmFjayB3aGljaCBzdWJzY3JpcHRpb25zIHdlIGNyZWF0ZWQsXG4gICAgICAvLyB3ZSdsbCBsaXN0IGFsbCBlbWFpbCBzdWJzY3JpcHRpb25zIGFuZCByZW1vdmUgdGhlbVxuICAgICAgY29uc29sZS5sb2coXCJEZWxldGUgcmVxdWVzdCAtIGNsZWFuaW5nIHVwIGVtYWlsIHN1YnNjcmlwdGlvbnNcIik7XG4gICAgICBcbiAgICAgIGNvbnN0IGFsbFN1YnNjcmlwdGlvbnMgPSBhd2FpdCBsaXN0VG9waWNTdWJzY3JpcHRpb25zKFRvcGljQXJuKTtcbiAgICAgIGNvbnN0IGVtYWlsU3Vic2NyaXB0aW9ucyA9IGFsbFN1YnNjcmlwdGlvbnNcbiAgICAgICAgLmZpbHRlcihzdWIgPT4gc3ViLlByb3RvY29sID09PSBcImVtYWlsXCIpXG4gICAgICAgIC5tYXAoc3ViID0+IHN1Yi5TdWJzY3JpcHRpb25Bcm4pO1xuICAgICAgXG4gICAgICBjb25zb2xlLmxvZyhcXGBGb3VuZCBcXCR7ZW1haWxTdWJzY3JpcHRpb25zLmxlbmd0aH0gZW1haWwgc3Vic2NyaXB0aW9uKHMpIHRvIHJlbW92ZVxcYCk7XG4gICAgICBhd2FpdCB1bnN1YnNjcmliZUVtYWlscyhlbWFpbFN1YnNjcmlwdGlvbnMpO1xuICAgICAgXG4gICAgICByZXR1cm4ge1xuICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCxcbiAgICAgIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJIYW5kbGVyIGVycm9yOlwiLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn07XG4gICAgICAgIGApLFxuICAgICAgICB0aW1lb3V0OiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICBsb2dSZXRlbnRpb246IGF3c19sb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIHJlYWQgU1NNIHBhcmFtZXRlclxuICAgIGhhbmRsZXIuYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBhd3NfaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgQXJuLmZvcm1hdChcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc2VydmljZTogXCJzc21cIixcbiAgICAgICAgICAgICAgcmVnaW9uOiBlZmZlY3RpdmVSZWdpb24sXG4gICAgICAgICAgICAgIHJlc291cmNlOiBcInBhcmFtZXRlclwiLFxuICAgICAgICAgICAgICByZXNvdXJjZU5hbWU6IHBhcmFtZXRlck5hbWUuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgICAgICAgICAgICA/IHBhcmFtZXRlck5hbWUuc2xpY2UoMSlcbiAgICAgICAgICAgICAgICA6IHBhcmFtZXRlck5hbWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RhY2tcbiAgICAgICAgICApLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gbWFuYWdlIFNOUyBzdWJzY3JpcHRpb25zXG4gICAgaGFuZGxlci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgYXdzX2lhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGF3c19pYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJzbnM6U3Vic2NyaWJlXCIsXG4gICAgICAgICAgXCJzbnM6VW5zdWJzY3JpYmVcIixcbiAgICAgICAgICBcInNuczpMaXN0U3Vic2NyaXB0aW9uc0J5VG9waWNcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbdG9waWNBcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBjdXN0b20gcmVzb3VyY2VcbiAgICBjb25zdCBwcm92aWRlciA9IG5ldyBDdXN0b21SZXNvdXJjZVNESy5Qcm92aWRlcihcbiAgICAgIHRoaXMsXG4gICAgICBcIkVtYWlsU3Vic2NyaWJlclByb3ZpZGVyXCIsXG4gICAgICB7XG4gICAgICAgIG9uRXZlbnRIYW5kbGVyOiBoYW5kbGVyLFxuICAgICAgICBsb2dSZXRlbnRpb246IGF3c19sb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICB9XG4gICAgKTtcblxuICAgIG5ldyBDdXN0b21SZXNvdXJjZSh0aGlzLCBcIkVtYWlsU3Vic2NyaWJlclJlc291cmNlXCIsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBUb3BpY0FybjogdG9waWNBcm4sXG4gICAgICAgIFBhcmFtZXRlck5hbWU6IHBhcmFtZXRlck5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG59XG4iXX0=