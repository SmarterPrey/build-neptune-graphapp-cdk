import { Stack, StackProps, aws_ec2, aws_iam, aws_kms, aws_sns, aws_rds } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as neptune from "@aws-cdk/aws-neptune-alpha";
import { NagSuppressions } from "cdk-nag";
import { Network } from "./constructs/network";
import { Neptune } from "./constructs/neptune";
import { NeptuneScheduler } from "./constructs/neptune-scheduler";
import { ParameterEmailSubscriber } from "./constructs/parameter-email-subscriber";

interface NeptuneScheduleConfig {
  /** Enable scheduled stop/start of Neptune (default: false) */
  enabled: boolean;
  /** IANA timezone (default: America/Los_Angeles) */
  timezone?: string;
  /** Hour to stop the cluster (default: 0 = midnight) */
  stopHour?: number;
  /** Hour to start the cluster (default: 16 = 4pm) */
  startHour?: number;
}

interface NeptuneNetworkStackProps extends StackProps {
  natSubnet?: boolean;
  maxAz: number;
  neptuneServerlss: boolean;
  neptuneServerlssCapacity?: neptune.ServerlessScalingConfiguration;
  /** Optional schedule to stop/start Neptune during off-hours */
  neptuneSchedule?: NeptuneScheduleConfig;
}

export class NeptuneNetworkStack extends Stack {
  public readonly vpc: aws_ec2.Vpc;
  public readonly cluster: neptune.DatabaseCluster;
  public readonly neptuneRole: aws_iam.Role;
  constructor(scope: Construct, id: string, props: NeptuneNetworkStackProps) {
    super(scope, id, props);

    const {
      natSubnet,
      maxAz,
      neptuneServerlss,
      neptuneServerlssCapacity,
      neptuneSchedule,
    } = props;

    const network = new Network(this, "network", {
      natSubnet,
      maxAz,
    });
    this.vpc = network.vpc;

    const neptune = new Neptune(this, "neptune", {
      vpc: network.vpc,
      neptuneServerlss,
      neptuneServerlssCapacity,
    });

    this.cluster = neptune.cluster;
    this.neptuneRole = neptune.neptuneRole;

    // Schedule Neptune stop/start to save costs during off-hours
    if (neptuneSchedule?.enabled) {
      new NeptuneScheduler(this, "neptune-scheduler", {
        cluster: this.cluster,
        timezone: neptuneSchedule.timezone,
        stopHour: neptuneSchedule.stopHour,
        startHour: neptuneSchedule.startHour,
      });
    }

    // SNS topic for Neptune cluster state change notifications
    const neptuneStatusKey = new aws_kms.Key(this, "NeptuneStatusTopicKey", {
      description: "KMS key for Neptune status SNS topic encryption",
      enableKeyRotation: true,
    });

    const neptuneStatusTopic = new aws_sns.Topic(this, "NeptuneStatusTopic", {
      displayName: "Neptune Cluster Status Notifications",
      masterKey: neptuneStatusKey,
    });

    // Enforce SSL-only access to the topic (AwsSolutions-SNS3)
    neptuneStatusTopic.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        sid: "AllowPublishThroughSSLOnly",
        effect: aws_iam.Effect.DENY,
        principals: [new aws_iam.AnyPrincipal()],
        actions: ["sns:Publish"],
        resources: [neptuneStatusTopic.topicArn],
        conditions: {
          Bool: { "aws:SecureTransport": "false" },
        },
      })
    );

    // Allow RDS/Neptune to publish to this encrypted topic
    neptuneStatusTopic.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        sid: "AllowRDSPublish",
        effect: aws_iam.Effect.ALLOW,
        principals: [new aws_iam.ServicePrincipal("events.rds.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [neptuneStatusTopic.topicArn],
      })
    );

    neptuneStatusKey.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        sid: "AllowRDSUseKey",
        effect: aws_iam.Effect.ALLOW,
        principals: [new aws_iam.ServicePrincipal("events.rds.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
      })
    );

    // Subscribe email addresses from Parameter Store
    new ParameterEmailSubscriber(this, "NeptuneEmailSubscriber", {
      topicArn: neptuneStatusTopic.topicArn,
      parameterName: "/global-app-params/rdsnotificationemails",
    });

    // RDS Event Subscription: notify on cluster failover, maintenance, and notification events
    new aws_rds.CfnEventSubscription(this, "NeptuneEventSubscription", {
      snsTopicArn: neptuneStatusTopic.topicArn,
      sourceType: "db-cluster",
      sourceIds: [this.cluster.clusterIdentifier],
      enabled: true,
      eventCategories: ["failover", "failure", "maintenance", "notification"],
    });

    // -----------------------------------------------------------------------
    // cdk-nag stack-level suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
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
        reason: "Wildcard permissions required for CDK managed resources",
        appliesTo: ["Resource::*"],
      },
    ]);
  }
}
