"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParameterEmailSubscriber = void 0;
var aws_cdk_lib_1 = require("aws-cdk-lib");
var CustomResourceSDK = require("aws-cdk-lib/custom-resources");
var constructs_1 = require("constructs");
var aws_iam = require("aws-cdk-lib/aws-iam");
var aws_lambda = require("aws-cdk-lib/aws-lambda");
var aws_logs = require("aws-cdk-lib/aws-logs");
var cdk_nag_1 = require("cdk-nag");
/**
 * Custom resource that reads email addresses from SSM Parameter Store
 * and subscribes them to an SNS topic.
 *
 * The parameter should contain comma-separated email addresses:
 * email1@example.com,email2@example.com
 *
 * On stack deletion, all subscriptions created by this resource are removed.
 */
var ParameterEmailSubscriber = /** @class */ (function (_super) {
    __extends(ParameterEmailSubscriber, _super);
    function ParameterEmailSubscriber(scope, id, props) {
        var _this = _super.call(this, scope, id) || this;
        var topicArn = props.topicArn, parameterName = props.parameterName, region = props.region;
        var stack = aws_cdk_lib_1.Stack.of(_this);
        var effectiveRegion = region || stack.region;
        // Create log group for Lambda function
        var handlerLogGroup = new aws_logs.LogGroup(_this, "EmailSubscriberHandlerLogGroup", {
            retention: aws_logs.RetentionDays.ONE_WEEK,
        });
        // Create Lambda function for custom resource handler
        var handler = new aws_lambda.SingletonFunction(_this, "EmailSubscriberHandler", {
            uuid: "parameter-email-subscriber-handler",
            runtime: aws_lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            logGroup: handlerLogGroup,
            code: aws_lambda.Code.fromInline("\nconst { SSMClient, GetParameterCommand } = require(\"@aws-sdk/client-ssm\");\nconst { SNSClient, SubscribeCommand, UnsubscribeCommand, ListSubscriptionsByTopicCommand } = require(\"@aws-sdk/client-sns\");\n\nconst ssm = new SSMClient();\nconst sns = new SNSClient();\n\nasync function getEmailsFromParameter(parameterName) {\n  try {\n    const command = new GetParameterCommand({ Name: parameterName });\n    const response = await ssm.send(command);\n    const value = response.Parameter?.Value || \"\";\n    \n    // Split by comma and trim whitespace\n    const emails = value\n      .split(\",\")\n      .map(email => email.trim())\n      .filter(email => email.length > 0);\n    \n    console.log(`Found ${emails.length} email(s) in parameter: ${emails.join(\", \")}`);\n    return emails;\n  } catch (error) {\n    // If parameter doesn't exist, return empty array (deployment can proceed)\n    if (error.name === \"ParameterNotFound\" || error.Code === \"ParameterNotFound\") {\n      console.warn(`Parameter ${parameterName} not found. No email subscriptions will be created.`);\n      return [];\n    }\n    console.error(\"Error reading parameter:\", error);\n    throw new Error(`Failed to read parameter ${parameterName}: ${error.message}`);\n  }\n}\n\nasync function subscribeEmails(topicArn, emails) {\n  const subscriptionArns = [];\n  \n  for (const email of emails) {\n    try {\n      const command = new SubscribeCommand({\n        TopicArn: topicArn,\n        Protocol: \"email\",\n        Endpoint: email,\n      });\n      const response = await sns.send(command);\n      console.log(`Subscribed ${email} to topic. Subscription ARN: ${response.SubscriptionArn}`);\n      subscriptionArns.push(response.SubscriptionArn);\n    } catch (error) {\n      console.error(`Error subscribing ${email}:`, error);\n      // Continue with other emails even if one fails\n    }\n  }\n  \n  return subscriptionArns;\n}\n\nasync function unsubscribeEmails(subscriptionArns) {\n  for (const arn of subscriptionArns) {\n    // Skip pending confirmations (they auto-expire)\n    if (arn === \"pending confirmation\") {\n      console.log(\"Skipping pending confirmation subscription\");\n      continue;\n    }\n    \n    try {\n      const command = new UnsubscribeCommand({ SubscriptionArn: arn });\n      await sns.send(command);\n      console.log(`Unsubscribed: ${arn}`);\n    } catch (error) {\n      console.error(`Error unsubscribing ${arn}:`, error);\n    }\n  }\n}\n\nasync function listTopicSubscriptions(topicArn) {\n  try {\n    const command = new ListSubscriptionsByTopicCommand({ TopicArn: topicArn });\n    const response = await sns.send(command);\n    return response.Subscriptions || [];\n  } catch (error) {\n    console.error(\"Error listing subscriptions:\", error);\n    return [];\n  }\n}\n\nexports.handler = async (event) => {\n  console.log(\"Event:\", JSON.stringify(event, null, 2));\n  \n  const { RequestType, ResourceProperties, PhysicalResourceId } = event;\n  const { TopicArn, ParameterName } = ResourceProperties;\n  \n  try {\n    if (RequestType === \"Create\" || RequestType === \"Update\") {\n      const emails = await getEmailsFromParameter(ParameterName);\n      \n      if (emails.length === 0) {\n        console.warn(\"No emails found in parameter. No subscriptions created.\");\n        return {\n          PhysicalResourceId: PhysicalResourceId || `email-subscriber-${Date.now()}`,\n          Data: {\n            SubscriptionCount: 0,\n            Emails: \"\",\n          },\n        };\n      }\n      \n      const subscriptionArns = await subscribeEmails(TopicArn, emails);\n      \n      return {\n        PhysicalResourceId: PhysicalResourceId || `email-subscriber-${Date.now()}`,\n        Data: {\n          SubscriptionCount: subscriptionArns.length,\n          Emails: emails.join(\",\"),\n          SubscriptionArns: subscriptionArns.join(\",\"),\n        },\n      };\n    } else if (RequestType === \"Delete\") {\n      // On deletion, remove all email subscriptions from the topic\n      // Note: We remove all email subscriptions since we can't reliably track\n      // which ones we created (SNS returns \"pending confirmation\" initially).\n      // This is acceptable for a dedicated Neptune notification topic.\n      console.log(\"Delete request - cleaning up email subscriptions\");\n      \n      const allSubscriptions = await listTopicSubscriptions(TopicArn);\n      const emailSubscriptions = allSubscriptions\n        .filter(sub => sub.Protocol === \"email\")\n        .map(sub => sub.SubscriptionArn);\n      \n      console.log(`Found ${emailSubscriptions.length} email subscription(s) to remove`);\n      await unsubscribeEmails(emailSubscriptions);\n      \n      return {\n        PhysicalResourceId: PhysicalResourceId,\n      };\n    }\n    \n    return {\n      PhysicalResourceId: PhysicalResourceId || `email-subscriber-${Date.now()}`,\n    };\n  } catch (error) {\n    console.error(\"Handler error:\", error);\n    throw error;\n  }\n};\n        "),
            timeout: aws_cdk_lib_1.Duration.seconds(30),
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
        // Create log group for custom resource provider
        var providerLogGroup = new aws_logs.LogGroup(_this, "EmailSubscriberProviderLogGroup", {
            retention: aws_logs.RetentionDays.ONE_WEEK,
        });
        // Create the custom resource
        var provider = new CustomResourceSDK.Provider(_this, "EmailSubscriberProvider", {
            onEventHandler: handler,
            logGroup: providerLogGroup,
        });
        new aws_cdk_lib_1.CustomResource(_this, "EmailSubscriberResource", {
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
        return _this;
    }
    return ParameterEmailSubscriber;
}(constructs_1.Construct));
exports.ParameterEmailSubscriber = ParameterEmailSubscriber;
