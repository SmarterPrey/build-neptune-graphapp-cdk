import { Arn, Stack, CustomResource, Duration } from "aws-cdk-lib";
import * as CustomResourceSDK from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as aws_iam from "aws-cdk-lib/aws-iam";
import * as aws_lambda from "aws-cdk-lib/aws-lambda";
import * as aws_logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";

export interface ParameterEmailSubscriberProps {
  /**
   * ARN of the SNS topic to subscribe emails to
   */
  topicArn: string;

  /**
   * Full path to the SSM Parameter containing comma-separated email addresses
   * Example: /global-app-params/rdsnotificationemails
   */
  parameterName: string;

  /**
   * Region where the parameter is stored (default: current region)
   */
  region?: string;
}

/**
 * Custom resource that reads email addresses from SSM Parameter Store
 * and subscribes them to an SNS topic.
 * 
 * The parameter should contain comma-separated email addresses:
 * email1@example.com,email2@example.com
 * 
 * On stack deletion, all subscriptions created by this resource are removed.
 */
export class ParameterEmailSubscriber extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: ParameterEmailSubscriberProps
  ) {
    super(scope, id);

    const { topicArn, parameterName, region } = props;
    const stack = Stack.of(this);
    const effectiveRegion = region || stack.region;

    // Create Lambda function for custom resource handler
    const handler = new aws_lambda.SingletonFunction(
      this,
      "EmailSubscriberHandler",
      {
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
        timeout: Duration.seconds(30),
        logGroup: new aws_logs.LogGroup(this, 'EmailSubscriberLogGroup', {
          retention: aws_logs.RetentionDays.ONE_WEEK,
        }),
      }
    );

    // Grant permissions to read SSM parameter
    handler.addToRolePolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          Arn.format(
            {
              service: "ssm",
              region: effectiveRegion,
              resource: "parameter",
              resourceName: parameterName.startsWith("/")
                ? parameterName.slice(1)
                : parameterName,
            },
            stack
          ),
        ],
      })
    );

    // Grant permissions to manage SNS subscriptions
    handler.addToRolePolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: [
          "sns:Subscribe",
          "sns:Unsubscribe",
          "sns:ListSubscriptionsByTopic",
        ],
        resources: [topicArn],
      })
    );

    // -----------------------------------------------------------------------
    // cdk-nag suppressions for handler (must be before provider creation)
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      handler,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access - CDK managed resource",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        {
          id: "AwsSolutions-L1",
          reason: "NODEJS_22_X is the latest supported runtime at deploy time",
        },
      ],
      true
    );

    // Create the custom resource
    const provider = new CustomResourceSDK.Provider(
      this,
      "EmailSubscriberProvider",
      {
        onEventHandler: handler,
        logGroup: new aws_logs.LogGroup(this, 'EmailSubscriberProviderLogGroup', {
          retention: aws_logs.RetentionDays.ONE_WEEK,
        }),
      }
    );

    new CustomResource(this, "EmailSubscriberResource", {
      serviceToken: provider.serviceToken,
      properties: {
        TopicArn: topicArn,
        ParameterName: parameterName,
      },
    });

    // -----------------------------------------------------------------------
    // cdk-nag suppressions for provider
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access - CDK managed resource",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard permissions required for custom resource provider framework - CDK managed resource",
        },
        {
          id: "AwsSolutions-L1",
          reason:
            "Custom resource provider uses CDK-managed Lambda runtime - CDK managed resource",
        },
      ],
      true
    );
  }
}
