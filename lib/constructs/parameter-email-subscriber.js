"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParameterEmailSubscriber = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const CustomResourceSDK = require("aws-cdk-lib/custom-resources");
const constructs_1 = require("constructs");
const aws_iam = require("aws-cdk-lib/aws-iam");
const aws_lambda = require("aws-cdk-lib/aws-lambda");
const aws_logs = require("aws-cdk-lib/aws-logs");
const cdk_nag_1 = require("cdk-nag");
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
            runtime: aws_lambda.Runtime.NODEJS_22_X,
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
    // If parameter doesn't exist, return empty array (deployment can proceed)
    if (error.name === "ParameterNotFound" || error.Code === "ParameterNotFound") {
      console.warn(\`Parameter \${parameterName} not found. No email subscriptions will be created.\`);
      return [];
    }
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
      // On deletion, remove all email subscriptions from the topic
      // Note: We remove all email subscriptions since we can't reliably track
      // which ones we created (SNS returns "pending confirmation" initially).
      // This is acceptable for a dedicated Neptune notification topic.
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
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            logGroup: new aws_logs.LogGroup(this, 'EmailSubscriberLogGroup', {
                retention: aws_logs.RetentionDays.ONE_WEEK,
            }),
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
        // -----------------------------------------------------------------------
        // cdk-nag suppressions for handler (must be before provider creation)
        // -----------------------------------------------------------------------
        cdk_nag_1.NagSuppressions.addResourceSuppressions(handler, [
            {
                id: "AwsSolutions-IAM4",
                reason: "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access - CDK managed resource",
                appliesTo: [
                    "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                ],
            },
            {
                id: "AwsSolutions-L1",
                reason: "NODEJS_22_X is the latest supported runtime at deploy time",
            },
        ], true);
        // Create the custom resource
        const provider = new CustomResourceSDK.Provider(this, "EmailSubscriberProvider", {
            onEventHandler: handler,
            logGroup: new aws_logs.LogGroup(this, 'EmailSubscriberProviderLogGroup', {
                retention: aws_logs.RetentionDays.ONE_WEEK,
            }),
        });
        new aws_cdk_lib_1.CustomResource(this, "EmailSubscriberResource", {
            serviceToken: provider.serviceToken,
            properties: {
                TopicArn: topicArn,
                ParameterName: parameterName,
            },
        });
        // -----------------------------------------------------------------------
        // cdk-nag suppressions for provider
        // -----------------------------------------------------------------------
        cdk_nag_1.NagSuppressions.addResourceSuppressions(provider, [
            {
                id: "AwsSolutions-IAM4",
                reason: "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access - CDK managed resource",
                appliesTo: [
                    "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                ],
            },
            {
                id: "AwsSolutions-IAM5",
                reason: "Wildcard permissions required for custom resource provider framework - CDK managed resource",
            },
            {
                id: "AwsSolutions-L1",
                reason: "Custom resource provider uses CDK-managed Lambda runtime - CDK managed resource",
            },
        ], true);
    }
}
exports.ParameterEmailSubscriber = ParameterEmailSubscriber;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYW1ldGVyLWVtYWlsLXN1YnNjcmliZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXJhbWV0ZXItZW1haWwtc3Vic2NyaWJlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw2Q0FBbUU7QUFDbkUsa0VBQWtFO0FBQ2xFLDJDQUF1QztBQUN2QywrQ0FBK0M7QUFDL0MscURBQXFEO0FBQ3JELGlEQUFpRDtBQUNqRCxxQ0FBMEM7QUFxQjFDOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSx3QkFBeUIsU0FBUSxzQkFBUztJQUNyRCxZQUNFLEtBQWdCLEVBQ2hCLEVBQVUsRUFDVixLQUFvQztRQUVwQyxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxRQUFRLEVBQUUsYUFBYSxFQUFFLE1BQU0sRUFBRSxHQUFHLEtBQUssQ0FBQztRQUNsRCxNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM3QixNQUFNLGVBQWUsR0FBRyxNQUFNLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUUvQyxxREFBcUQ7UUFDckQsTUFBTSxPQUFPLEdBQUcsSUFBSSxVQUFVLENBQUMsaUJBQWlCLENBQzlDLElBQUksRUFDSix3QkFBd0IsRUFDeEI7WUFDRSxJQUFJLEVBQUUsb0NBQW9DO1lBQzFDLE9BQU8sRUFBRSxVQUFVLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDdkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLFVBQVUsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O1NBOEloQyxDQUFDO1lBQ0YsT0FBTyxFQUFFLHNCQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUM3QixRQUFRLEVBQUUsSUFBSSxRQUFRLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtnQkFDL0QsU0FBUyxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsUUFBUTthQUMzQyxDQUFDO1NBQ0gsQ0FDRixDQUFDO1FBRUYsMENBQTBDO1FBQzFDLE9BQU8sQ0FBQyxlQUFlLENBQ3JCLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQztZQUMxQixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQzVCLE9BQU8sRUFBRSxDQUFDLGtCQUFrQixDQUFDO1lBQzdCLFNBQVMsRUFBRTtnQkFDVCxpQkFBRyxDQUFDLE1BQU0sQ0FDUjtvQkFDRSxPQUFPLEVBQUUsS0FBSztvQkFDZCxNQUFNLEVBQUUsZUFBZTtvQkFDdkIsUUFBUSxFQUFFLFdBQVc7b0JBQ3JCLFlBQVksRUFBRSxhQUFhLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQzt3QkFDekMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO3dCQUN4QixDQUFDLENBQUMsYUFBYTtpQkFDbEIsRUFDRCxLQUFLLENBQ047YUFDRjtTQUNGLENBQUMsQ0FDSCxDQUFDO1FBRUYsZ0RBQWdEO1FBQ2hELE9BQU8sQ0FBQyxlQUFlLENBQ3JCLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQztZQUMxQixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQzVCLE9BQU8sRUFBRTtnQkFDUCxlQUFlO2dCQUNmLGlCQUFpQjtnQkFDakIsOEJBQThCO2FBQy9CO1lBQ0QsU0FBUyxFQUFFLENBQUMsUUFBUSxDQUFDO1NBQ3RCLENBQUMsQ0FDSCxDQUFDO1FBRUYsMEVBQTBFO1FBQzFFLHNFQUFzRTtRQUN0RSwwRUFBMEU7UUFDMUUseUJBQWUsQ0FBQyx1QkFBdUIsQ0FDckMsT0FBTyxFQUNQO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUNKLDJGQUEyRjtnQkFDN0YsU0FBUyxFQUFFO29CQUNULHVGQUF1RjtpQkFDeEY7YUFDRjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0REFBNEQ7YUFDckU7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO1FBRUYsNkJBQTZCO1FBQzdCLE1BQU0sUUFBUSxHQUFHLElBQUksaUJBQWlCLENBQUMsUUFBUSxDQUM3QyxJQUFJLEVBQ0oseUJBQXlCLEVBQ3pCO1lBQ0UsY0FBYyxFQUFFLE9BQU87WUFDdkIsUUFBUSxFQUFFLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsaUNBQWlDLEVBQUU7Z0JBQ3ZFLFNBQVMsRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLFFBQVE7YUFDM0MsQ0FBQztTQUNILENBQ0YsQ0FBQztRQUVGLElBQUksNEJBQWMsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDbEQsWUFBWSxFQUFFLFFBQVEsQ0FBQyxZQUFZO1lBQ25DLFVBQVUsRUFBRTtnQkFDVixRQUFRLEVBQUUsUUFBUTtnQkFDbEIsYUFBYSxFQUFFLGFBQWE7YUFDN0I7U0FDRixDQUFDLENBQUM7UUFFSCwwRUFBMEU7UUFDMUUsb0NBQW9DO1FBQ3BDLDBFQUEwRTtRQUMxRSx5QkFBZSxDQUFDLHVCQUF1QixDQUNyQyxRQUFRLEVBQ1I7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQ0osMkZBQTJGO2dCQUM3RixTQUFTLEVBQUU7b0JBQ1QsdUZBQXVGO2lCQUN4RjthQUNGO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUNKLDZGQUE2RjthQUNoRztZQUNEO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFDSixpRkFBaUY7YUFDcEY7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBbFJELDREQWtSQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEFybiwgU3RhY2ssIEN1c3RvbVJlc291cmNlLCBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgQ3VzdG9tUmVzb3VyY2VTREsgZnJvbSBcImF3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBhd3NfaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBhd3NfbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBhd3NfbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gXCJjZGstbmFnXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFyYW1ldGVyRW1haWxTdWJzY3JpYmVyUHJvcHMge1xuICAvKipcbiAgICogQVJOIG9mIHRoZSBTTlMgdG9waWMgdG8gc3Vic2NyaWJlIGVtYWlscyB0b1xuICAgKi9cbiAgdG9waWNBcm46IHN0cmluZztcblxuICAvKipcbiAgICogRnVsbCBwYXRoIHRvIHRoZSBTU00gUGFyYW1ldGVyIGNvbnRhaW5pbmcgY29tbWEtc2VwYXJhdGVkIGVtYWlsIGFkZHJlc3Nlc1xuICAgKiBFeGFtcGxlOiAvZ2xvYmFsLWFwcC1wYXJhbXMvcmRzbm90aWZpY2F0aW9uZW1haWxzXG4gICAqL1xuICBwYXJhbWV0ZXJOYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJlZ2lvbiB3aGVyZSB0aGUgcGFyYW1ldGVyIGlzIHN0b3JlZCAoZGVmYXVsdDogY3VycmVudCByZWdpb24pXG4gICAqL1xuICByZWdpb24/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ3VzdG9tIHJlc291cmNlIHRoYXQgcmVhZHMgZW1haWwgYWRkcmVzc2VzIGZyb20gU1NNIFBhcmFtZXRlciBTdG9yZVxuICogYW5kIHN1YnNjcmliZXMgdGhlbSB0byBhbiBTTlMgdG9waWMuXG4gKiBcbiAqIFRoZSBwYXJhbWV0ZXIgc2hvdWxkIGNvbnRhaW4gY29tbWEtc2VwYXJhdGVkIGVtYWlsIGFkZHJlc3NlczpcbiAqIGVtYWlsMUBleGFtcGxlLmNvbSxlbWFpbDJAZXhhbXBsZS5jb21cbiAqIFxuICogT24gc3RhY2sgZGVsZXRpb24sIGFsbCBzdWJzY3JpcHRpb25zIGNyZWF0ZWQgYnkgdGhpcyByZXNvdXJjZSBhcmUgcmVtb3ZlZC5cbiAqL1xuZXhwb3J0IGNsYXNzIFBhcmFtZXRlckVtYWlsU3Vic2NyaWJlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHNjb3BlOiBDb25zdHJ1Y3QsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwcm9wczogUGFyYW1ldGVyRW1haWxTdWJzY3JpYmVyUHJvcHNcbiAgKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgdG9waWNBcm4sIHBhcmFtZXRlck5hbWUsIHJlZ2lvbiB9ID0gcHJvcHM7XG4gICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICBjb25zdCBlZmZlY3RpdmVSZWdpb24gPSByZWdpb24gfHwgc3RhY2sucmVnaW9uO1xuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBmdW5jdGlvbiBmb3IgY3VzdG9tIHJlc291cmNlIGhhbmRsZXJcbiAgICBjb25zdCBoYW5kbGVyID0gbmV3IGF3c19sYW1iZGEuU2luZ2xldG9uRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJFbWFpbFN1YnNjcmliZXJIYW5kbGVyXCIsXG4gICAgICB7XG4gICAgICAgIHV1aWQ6IFwicGFyYW1ldGVyLWVtYWlsLXN1YnNjcmliZXItaGFuZGxlclwiLFxuICAgICAgICBydW50aW1lOiBhd3NfbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlOiBhd3NfbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG5jb25zdCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9ID0gcmVxdWlyZShcIkBhd3Mtc2RrL2NsaWVudC1zc21cIik7XG5jb25zdCB7IFNOU0NsaWVudCwgU3Vic2NyaWJlQ29tbWFuZCwgVW5zdWJzY3JpYmVDb21tYW5kLCBMaXN0U3Vic2NyaXB0aW9uc0J5VG9waWNDb21tYW5kIH0gPSByZXF1aXJlKFwiQGF3cy1zZGsvY2xpZW50LXNuc1wiKTtcblxuY29uc3Qgc3NtID0gbmV3IFNTTUNsaWVudCgpO1xuY29uc3Qgc25zID0gbmV3IFNOU0NsaWVudCgpO1xuXG5hc3luYyBmdW5jdGlvbiBnZXRFbWFpbHNGcm9tUGFyYW1ldGVyKHBhcmFtZXRlck5hbWUpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IEdldFBhcmFtZXRlckNvbW1hbmQoeyBOYW1lOiBwYXJhbWV0ZXJOYW1lIH0pO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc3NtLnNlbmQoY29tbWFuZCk7XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZS5QYXJhbWV0ZXI/LlZhbHVlIHx8IFwiXCI7XG4gICAgXG4gICAgLy8gU3BsaXQgYnkgY29tbWEgYW5kIHRyaW0gd2hpdGVzcGFjZVxuICAgIGNvbnN0IGVtYWlscyA9IHZhbHVlXG4gICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAubWFwKGVtYWlsID0+IGVtYWlsLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoZW1haWwgPT4gZW1haWwubGVuZ3RoID4gMCk7XG4gICAgXG4gICAgY29uc29sZS5sb2coXFxgRm91bmQgXFwke2VtYWlscy5sZW5ndGh9IGVtYWlsKHMpIGluIHBhcmFtZXRlcjogXFwke2VtYWlscy5qb2luKFwiLCBcIil9XFxgKTtcbiAgICByZXR1cm4gZW1haWxzO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIElmIHBhcmFtZXRlciBkb2Vzbid0IGV4aXN0LCByZXR1cm4gZW1wdHkgYXJyYXkgKGRlcGxveW1lbnQgY2FuIHByb2NlZWQpXG4gICAgaWYgKGVycm9yLm5hbWUgPT09IFwiUGFyYW1ldGVyTm90Rm91bmRcIiB8fCBlcnJvci5Db2RlID09PSBcIlBhcmFtZXRlck5vdEZvdW5kXCIpIHtcbiAgICAgIGNvbnNvbGUud2FybihcXGBQYXJhbWV0ZXIgXFwke3BhcmFtZXRlck5hbWV9IG5vdCBmb3VuZC4gTm8gZW1haWwgc3Vic2NyaXB0aW9ucyB3aWxsIGJlIGNyZWF0ZWQuXFxgKTtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc29sZS5lcnJvcihcIkVycm9yIHJlYWRpbmcgcGFyYW1ldGVyOlwiLCBlcnJvcik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxcYEZhaWxlZCB0byByZWFkIHBhcmFtZXRlciBcXCR7cGFyYW1ldGVyTmFtZX06IFxcJHtlcnJvci5tZXNzYWdlfVxcYCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3Vic2NyaWJlRW1haWxzKHRvcGljQXJuLCBlbWFpbHMpIHtcbiAgY29uc3Qgc3Vic2NyaXB0aW9uQXJucyA9IFtdO1xuICBcbiAgZm9yIChjb25zdCBlbWFpbCBvZiBlbWFpbHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY29tbWFuZCA9IG5ldyBTdWJzY3JpYmVDb21tYW5kKHtcbiAgICAgICAgVG9waWNBcm46IHRvcGljQXJuLFxuICAgICAgICBQcm90b2NvbDogXCJlbWFpbFwiLFxuICAgICAgICBFbmRwb2ludDogZW1haWwsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc25zLnNlbmQoY29tbWFuZCk7XG4gICAgICBjb25zb2xlLmxvZyhcXGBTdWJzY3JpYmVkIFxcJHtlbWFpbH0gdG8gdG9waWMuIFN1YnNjcmlwdGlvbiBBUk46IFxcJHtyZXNwb25zZS5TdWJzY3JpcHRpb25Bcm59XFxgKTtcbiAgICAgIHN1YnNjcmlwdGlvbkFybnMucHVzaChyZXNwb25zZS5TdWJzY3JpcHRpb25Bcm4pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFxcYEVycm9yIHN1YnNjcmliaW5nIFxcJHtlbWFpbH06XFxgLCBlcnJvcik7XG4gICAgICAvLyBDb250aW51ZSB3aXRoIG90aGVyIGVtYWlscyBldmVuIGlmIG9uZSBmYWlsc1xuICAgIH1cbiAgfVxuICBcbiAgcmV0dXJuIHN1YnNjcmlwdGlvbkFybnM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVuc3Vic2NyaWJlRW1haWxzKHN1YnNjcmlwdGlvbkFybnMpIHtcbiAgZm9yIChjb25zdCBhcm4gb2Ygc3Vic2NyaXB0aW9uQXJucykge1xuICAgIC8vIFNraXAgcGVuZGluZyBjb25maXJtYXRpb25zICh0aGV5IGF1dG8tZXhwaXJlKVxuICAgIGlmIChhcm4gPT09IFwicGVuZGluZyBjb25maXJtYXRpb25cIikge1xuICAgICAgY29uc29sZS5sb2coXCJTa2lwcGluZyBwZW5kaW5nIGNvbmZpcm1hdGlvbiBzdWJzY3JpcHRpb25cIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgVW5zdWJzY3JpYmVDb21tYW5kKHsgU3Vic2NyaXB0aW9uQXJuOiBhcm4gfSk7XG4gICAgICBhd2FpdCBzbnMuc2VuZChjb21tYW5kKTtcbiAgICAgIGNvbnNvbGUubG9nKFxcYFVuc3Vic2NyaWJlZDogXFwke2Fybn1cXGApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFxcYEVycm9yIHVuc3Vic2NyaWJpbmcgXFwke2Fybn06XFxgLCBlcnJvcik7XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RUb3BpY1N1YnNjcmlwdGlvbnModG9waWNBcm4pIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IExpc3RTdWJzY3JpcHRpb25zQnlUb3BpY0NvbW1hbmQoeyBUb3BpY0FybjogdG9waWNBcm4gfSk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzbnMuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzcG9uc2UuU3Vic2NyaXB0aW9ucyB8fCBbXTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiRXJyb3IgbGlzdGluZyBzdWJzY3JpcHRpb25zOlwiLCBlcnJvcik7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICBjb25zb2xlLmxvZyhcIkV2ZW50OlwiLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuICBcbiAgY29uc3QgeyBSZXF1ZXN0VHlwZSwgUmVzb3VyY2VQcm9wZXJ0aWVzLCBQaHlzaWNhbFJlc291cmNlSWQgfSA9IGV2ZW50O1xuICBjb25zdCB7IFRvcGljQXJuLCBQYXJhbWV0ZXJOYW1lIH0gPSBSZXNvdXJjZVByb3BlcnRpZXM7XG4gIFxuICB0cnkge1xuICAgIGlmIChSZXF1ZXN0VHlwZSA9PT0gXCJDcmVhdGVcIiB8fCBSZXF1ZXN0VHlwZSA9PT0gXCJVcGRhdGVcIikge1xuICAgICAgY29uc3QgZW1haWxzID0gYXdhaXQgZ2V0RW1haWxzRnJvbVBhcmFtZXRlcihQYXJhbWV0ZXJOYW1lKTtcbiAgICAgIFxuICAgICAgaWYgKGVtYWlscy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiTm8gZW1haWxzIGZvdW5kIGluIHBhcmFtZXRlci4gTm8gc3Vic2NyaXB0aW9ucyBjcmVhdGVkLlwiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICAgICAgICBEYXRhOiB7XG4gICAgICAgICAgICBTdWJzY3JpcHRpb25Db3VudDogMCxcbiAgICAgICAgICAgIEVtYWlsczogXCJcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgXG4gICAgICBjb25zdCBzdWJzY3JpcHRpb25Bcm5zID0gYXdhaXQgc3Vic2NyaWJlRW1haWxzKFRvcGljQXJuLCBlbWFpbHMpO1xuICAgICAgXG4gICAgICByZXR1cm4ge1xuICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICAgICAgRGF0YToge1xuICAgICAgICAgIFN1YnNjcmlwdGlvbkNvdW50OiBzdWJzY3JpcHRpb25Bcm5zLmxlbmd0aCxcbiAgICAgICAgICBFbWFpbHM6IGVtYWlscy5qb2luKFwiLFwiKSxcbiAgICAgICAgICBTdWJzY3JpcHRpb25Bcm5zOiBzdWJzY3JpcHRpb25Bcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKFJlcXVlc3RUeXBlID09PSBcIkRlbGV0ZVwiKSB7XG4gICAgICAvLyBPbiBkZWxldGlvbiwgcmVtb3ZlIGFsbCBlbWFpbCBzdWJzY3JpcHRpb25zIGZyb20gdGhlIHRvcGljXG4gICAgICAvLyBOb3RlOiBXZSByZW1vdmUgYWxsIGVtYWlsIHN1YnNjcmlwdGlvbnMgc2luY2Ugd2UgY2FuJ3QgcmVsaWFibHkgdHJhY2tcbiAgICAgIC8vIHdoaWNoIG9uZXMgd2UgY3JlYXRlZCAoU05TIHJldHVybnMgXCJwZW5kaW5nIGNvbmZpcm1hdGlvblwiIGluaXRpYWxseSkuXG4gICAgICAvLyBUaGlzIGlzIGFjY2VwdGFibGUgZm9yIGEgZGVkaWNhdGVkIE5lcHR1bmUgbm90aWZpY2F0aW9uIHRvcGljLlxuICAgICAgY29uc29sZS5sb2coXCJEZWxldGUgcmVxdWVzdCAtIGNsZWFuaW5nIHVwIGVtYWlsIHN1YnNjcmlwdGlvbnNcIik7XG4gICAgICBcbiAgICAgIGNvbnN0IGFsbFN1YnNjcmlwdGlvbnMgPSBhd2FpdCBsaXN0VG9waWNTdWJzY3JpcHRpb25zKFRvcGljQXJuKTtcbiAgICAgIGNvbnN0IGVtYWlsU3Vic2NyaXB0aW9ucyA9IGFsbFN1YnNjcmlwdGlvbnNcbiAgICAgICAgLmZpbHRlcihzdWIgPT4gc3ViLlByb3RvY29sID09PSBcImVtYWlsXCIpXG4gICAgICAgIC5tYXAoc3ViID0+IHN1Yi5TdWJzY3JpcHRpb25Bcm4pO1xuICAgICAgXG4gICAgICBjb25zb2xlLmxvZyhcXGBGb3VuZCBcXCR7ZW1haWxTdWJzY3JpcHRpb25zLmxlbmd0aH0gZW1haWwgc3Vic2NyaXB0aW9uKHMpIHRvIHJlbW92ZVxcYCk7XG4gICAgICBhd2FpdCB1bnN1YnNjcmliZUVtYWlscyhlbWFpbFN1YnNjcmlwdGlvbnMpO1xuICAgICAgXG4gICAgICByZXR1cm4ge1xuICAgICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCxcbiAgICAgIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IFBoeXNpY2FsUmVzb3VyY2VJZCB8fCBcXGBlbWFpbC1zdWJzY3JpYmVyLVxcJHtEYXRlLm5vdygpfVxcYCxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJIYW5kbGVyIGVycm9yOlwiLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn07XG4gICAgICAgIGApLFxuICAgICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgbG9nR3JvdXA6IG5ldyBhd3NfbG9ncy5Mb2dHcm91cCh0aGlzLCAnRW1haWxTdWJzY3JpYmVyTG9nR3JvdXAnLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBhd3NfbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICB9KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gcmVhZCBTU00gcGFyYW1ldGVyXG4gICAgaGFuZGxlci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgYXdzX2lhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGF3c19pYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBBcm4uZm9ybWF0KFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzZXJ2aWNlOiBcInNzbVwiLFxuICAgICAgICAgICAgICByZWdpb246IGVmZmVjdGl2ZVJlZ2lvbixcbiAgICAgICAgICAgICAgcmVzb3VyY2U6IFwicGFyYW1ldGVyXCIsXG4gICAgICAgICAgICAgIHJlc291cmNlTmFtZTogcGFyYW1ldGVyTmFtZS5zdGFydHNXaXRoKFwiL1wiKVxuICAgICAgICAgICAgICAgID8gcGFyYW1ldGVyTmFtZS5zbGljZSgxKVxuICAgICAgICAgICAgICAgIDogcGFyYW1ldGVyTmFtZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzdGFja1xuICAgICAgICAgICksXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9ucyB0byBtYW5hZ2UgU05TIHN1YnNjcmlwdGlvbnNcbiAgICBoYW5kbGVyLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBhd3NfaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogYXdzX2lhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcInNuczpTdWJzY3JpYmVcIixcbiAgICAgICAgICBcInNuczpVbnN1YnNjcmliZVwiLFxuICAgICAgICAgIFwic25zOkxpc3RTdWJzY3JpcHRpb25zQnlUb3BpY1wiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFt0b3BpY0Fybl0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIGNkay1uYWcgc3VwcHJlc3Npb25zIGZvciBoYW5kbGVyIChtdXN0IGJlIGJlZm9yZSBwcm92aWRlciBjcmVhdGlvbilcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIGhhbmRsZXIsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNFwiLFxuICAgICAgICAgIHJlYXNvbjpcbiAgICAgICAgICAgIFwiQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIHJlcXVpcmVkIGZvciBDbG91ZFdhdGNoIExvZ3MgYWNjZXNzIC0gQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICAgIFwiUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtTDFcIixcbiAgICAgICAgICByZWFzb246IFwiTk9ERUpTXzIyX1ggaXMgdGhlIGxhdGVzdCBzdXBwb3J0ZWQgcnVudGltZSBhdCBkZXBsb3kgdGltZVwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBjdXN0b20gcmVzb3VyY2VcbiAgICBjb25zdCBwcm92aWRlciA9IG5ldyBDdXN0b21SZXNvdXJjZVNESy5Qcm92aWRlcihcbiAgICAgIHRoaXMsXG4gICAgICBcIkVtYWlsU3Vic2NyaWJlclByb3ZpZGVyXCIsXG4gICAgICB7XG4gICAgICAgIG9uRXZlbnRIYW5kbGVyOiBoYW5kbGVyLFxuICAgICAgICBsb2dHcm91cDogbmV3IGF3c19sb2dzLkxvZ0dyb3VwKHRoaXMsICdFbWFpbFN1YnNjcmliZXJQcm92aWRlckxvZ0dyb3VwJywge1xuICAgICAgICAgIHJldGVudGlvbjogYXdzX2xvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgICAgfSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIG5ldyBDdXN0b21SZXNvdXJjZSh0aGlzLCBcIkVtYWlsU3Vic2NyaWJlclJlc291cmNlXCIsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBUb3BpY0FybjogdG9waWNBcm4sXG4gICAgICAgIFBhcmFtZXRlck5hbWU6IHBhcmFtZXRlck5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBjZGstbmFnIHN1cHByZXNzaW9ucyBmb3IgcHJvdmlkZXJcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIHByb3ZpZGVyLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTRcIixcbiAgICAgICAgICByZWFzb246XG4gICAgICAgICAgICBcIkFXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyByZXF1aXJlZCBmb3IgQ2xvdWRXYXRjaCBMb2dzIGFjY2VzcyAtIENESyBtYW5hZ2VkIHJlc291cmNlXCIsXG4gICAgICAgICAgYXBwbGllc1RvOiBbXG4gICAgICAgICAgICBcIlBvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIixcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgICByZWFzb246XG4gICAgICAgICAgICBcIldpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBjdXN0b20gcmVzb3VyY2UgcHJvdmlkZXIgZnJhbWV3b3JrIC0gQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1MMVwiLFxuICAgICAgICAgIHJlYXNvbjpcbiAgICAgICAgICAgIFwiQ3VzdG9tIHJlc291cmNlIHByb3ZpZGVyIHVzZXMgQ0RLLW1hbmFnZWQgTGFtYmRhIHJ1bnRpbWUgLSBDREsgbWFuYWdlZCByZXNvdXJjZVwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuICB9XG59XG4iXX0=