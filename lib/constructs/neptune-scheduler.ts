import {
  Arn,
  ArnFormat,
  Duration,
  Stack,
  StackProps,
  aws_iam,
  aws_lambda,
  aws_lambda_nodejs,
  aws_scheduler,
} from "aws-cdk-lib";
import * as neptune from "@aws-cdk/aws-neptune-alpha";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";

interface NeptuneSchedulerProps extends StackProps {
  cluster: neptune.DatabaseCluster;
  /** IANA timezone for the schedule (default: America/Los_Angeles) */
  timezone?: string;
  /** Cron hour (0-23) to stop the cluster in the given timezone (default: 0 = midnight) */
  stopHour?: number;
  /** Cron hour (0-23) to start the cluster in the given timezone (default: 16 = 4pm) */
  startHour?: number;
}

export class NeptuneScheduler extends Construct {
  constructor(scope: Construct, id: string, props: NeptuneSchedulerProps) {
    super(scope, id);

    const {
      cluster,
      timezone = "America/Los_Angeles",
      stopHour = 0,
      startHour = 16,
    } = props;

    // The L2 cluster doesn't expose clusterIdentifier directly on the type,
    // but the underlying CFN resource has it. Use clusterResourceIdentifier
    // via the cluster endpoint address to derive it, or use Fn::Select.
    const clusterIdentifier = cluster.clusterIdentifier;

    // Construct the cluster ARN (not exposed by the L2 construct)
    const clusterArn = Arn.format(
      {
        service: "rds",
        resource: "cluster",
        resourceName: clusterIdentifier,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      Stack.of(this)
    );

    // -----------------------------------------------------------------------
    // Lambda that stops / starts the Neptune cluster
    // -----------------------------------------------------------------------
    const schedulerFn = new aws_lambda_nodejs.NodejsFunction(
      this,
      "neptune-scheduler-fn",
      {
        runtime: aws_lambda.Runtime.NODEJS_24_X,
        entry: path.join(
          __dirname,
          "..",
          "..",
          "api",
          "lambda",
          "neptuneScheduler",
          "index.ts"
        ),
        handler: "handler",
        timeout: Duration.seconds(30),
        environment: {
          NEPTUNE_CLUSTER_ID: clusterIdentifier,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],  // use SDK v3 from Lambda runtime
          minify: true,
          sourceMap: true,
        },
      }
    );

    // Grant the Lambda permission to stop/start the Neptune cluster
    schedulerFn.addToRolePolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: [
          "rds:StopDBCluster",
          "rds:StartDBCluster",
          "rds:DescribeDBClusters",
        ],
        resources: [clusterArn],
      })
    );

    // -----------------------------------------------------------------------
    // EventBridge Scheduler role
    // -----------------------------------------------------------------------
    const schedulerRole = new aws_iam.Role(this, "scheduler-role", {
      assumedBy: new aws_iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    schedulerFn.grantInvoke(schedulerRole);

    // -----------------------------------------------------------------------
    // cdk-nag suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      schedulerFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access",
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

    NagSuppressions.addResourceSuppressions(
      schedulerRole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard on Lambda ARN version is required by grantInvoke for EventBridge Scheduler",
        },
      ],
      true
    );

    // -----------------------------------------------------------------------
    // Schedules (timezone-aware via EventBridge Scheduler)
    // -----------------------------------------------------------------------

    // Stop Neptune at the configured hour (default: midnight Pacific)
    new aws_scheduler.CfnSchedule(this, "stop-schedule", {
      name: "neptune-stop-schedule",
      description: `Stop Neptune cluster at ${stopHour}:00 ${timezone}`,
      scheduleExpressionTimezone: timezone,
      scheduleExpression: `cron(0 ${stopHour} * * ? *)`,
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: schedulerFn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ action: "stop" }),
      },
      state: "ENABLED",
    });

    // Start Neptune at the configured hour (default: 4pm Pacific)
    new aws_scheduler.CfnSchedule(this, "start-schedule", {
      name: "neptune-start-schedule",
      description: `Start Neptune cluster at ${startHour}:00 ${timezone}`,
      scheduleExpressionTimezone: timezone,
      scheduleExpression: `cron(0 ${startHour} * * ? *)`,
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: schedulerFn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ action: "start" }),
      },
      state: "ENABLED",
    });
  }
}
