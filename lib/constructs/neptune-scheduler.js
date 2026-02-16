"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeptuneScheduler = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk_nag_1 = require("cdk-nag");
const constructs_1 = require("constructs");
const path = require("path");
class NeptuneScheduler extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { cluster, timezone = "America/Los_Angeles", stopHour = 0, startHour = 16, } = props;
        // The L2 cluster doesn't expose clusterIdentifier directly on the type,
        // but the underlying CFN resource has it. Use clusterResourceIdentifier
        // via the cluster endpoint address to derive it, or use Fn::Select.
        const clusterIdentifier = cluster.clusterIdentifier;
        // Construct the cluster ARN (not exposed by the L2 construct)
        const clusterArn = aws_cdk_lib_1.Arn.format({
            service: "rds",
            resource: "cluster",
            resourceName: clusterIdentifier,
            arnFormat: aws_cdk_lib_1.ArnFormat.COLON_RESOURCE_NAME,
        }, aws_cdk_lib_1.Stack.of(this));
        // -----------------------------------------------------------------------
        // Lambda that stops / starts the Neptune cluster
        // -----------------------------------------------------------------------
        const schedulerFn = new aws_cdk_lib_1.aws_lambda_nodejs.NodejsFunction(this, "neptune-scheduler-fn", {
            runtime: aws_cdk_lib_1.aws_lambda.Runtime.NODEJS_24_X,
            entry: path.join(__dirname, "..", "..", "api", "lambda", "neptuneScheduler", "index.ts"),
            handler: "handler",
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                NEPTUNE_CLUSTER_ID: clusterIdentifier,
            },
            bundling: {
                externalModules: ["@aws-sdk/*"], // use SDK v3 from Lambda runtime
                minify: true,
                sourceMap: true,
            },
        });
        // Grant the Lambda permission to stop/start the Neptune cluster
        schedulerFn.addToRolePolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            effect: aws_cdk_lib_1.aws_iam.Effect.ALLOW,
            actions: [
                "rds:StopDBCluster",
                "rds:StartDBCluster",
                "rds:DescribeDBClusters",
            ],
            resources: [clusterArn],
        }));
        // -----------------------------------------------------------------------
        // EventBridge Scheduler role
        // -----------------------------------------------------------------------
        const schedulerRole = new aws_cdk_lib_1.aws_iam.Role(this, "scheduler-role", {
            assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal("scheduler.amazonaws.com"),
        });
        schedulerFn.grantInvoke(schedulerRole);
        // -----------------------------------------------------------------------
        // cdk-nag suppressions
        // -----------------------------------------------------------------------
        cdk_nag_1.NagSuppressions.addResourceSuppressions(schedulerFn, [
            {
                id: "AwsSolutions-IAM4",
                reason: "AWSLambdaBasicExecutionRole is required for CloudWatch Logs access",
                appliesTo: [
                    "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                ],
            },
            {
                id: "AwsSolutions-L1",
                reason: "NODEJS_22_X is the latest supported runtime at deploy time",
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(schedulerRole, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Wildcard on Lambda ARN version is required by grantInvoke for EventBridge Scheduler",
            },
        ], true);
        // -----------------------------------------------------------------------
        // Schedules (timezone-aware via EventBridge Scheduler)
        // -----------------------------------------------------------------------
        // Stop Neptune at the configured hour (default: midnight Pacific)
        new aws_cdk_lib_1.aws_scheduler.CfnSchedule(this, "stop-schedule", {
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
        new aws_cdk_lib_1.aws_scheduler.CfnSchedule(this, "start-schedule", {
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
exports.NeptuneScheduler = NeptuneScheduler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmVwdHVuZS1zY2hlZHVsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJuZXB0dW5lLXNjaGVkdWxlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw2Q0FVcUI7QUFFckIscUNBQTBDO0FBQzFDLDJDQUF1QztBQUN2Qyw2QkFBNkI7QUFZN0IsTUFBYSxnQkFBaUIsU0FBUSxzQkFBUztJQUM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUNKLE9BQU8sRUFDUCxRQUFRLEdBQUcscUJBQXFCLEVBQ2hDLFFBQVEsR0FBRyxDQUFDLEVBQ1osU0FBUyxHQUFHLEVBQUUsR0FDZixHQUFHLEtBQUssQ0FBQztRQUVWLHdFQUF3RTtRQUN4RSx3RUFBd0U7UUFDeEUsb0VBQW9FO1FBQ3BFLE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLGlCQUFpQixDQUFDO1FBRXBELDhEQUE4RDtRQUM5RCxNQUFNLFVBQVUsR0FBRyxpQkFBRyxDQUFDLE1BQU0sQ0FDM0I7WUFDRSxPQUFPLEVBQUUsS0FBSztZQUNkLFFBQVEsRUFBRSxTQUFTO1lBQ25CLFlBQVksRUFBRSxpQkFBaUI7WUFDL0IsU0FBUyxFQUFFLHVCQUFTLENBQUMsbUJBQW1CO1NBQ3pDLEVBQ0QsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQ2YsQ0FBQztRQUVGLDBFQUEwRTtRQUMxRSxpREFBaUQ7UUFDakQsMEVBQTBFO1FBQzFFLE1BQU0sV0FBVyxHQUFHLElBQUksK0JBQWlCLENBQUMsY0FBYyxDQUN0RCxJQUFJLEVBQ0osc0JBQXNCLEVBQ3RCO1lBQ0UsT0FBTyxFQUFFLHdCQUFVLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDdkMsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQ2QsU0FBUyxFQUNULElBQUksRUFDSixJQUFJLEVBQ0osS0FBSyxFQUNMLFFB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QUFFLFdBQVcsQ0FBQyxXQUFXO2dCQUM1QixPQUFPLEVBQUUsYUFBYSxDQUFDLE9BQU87Z0JBQzlCLEtBQUssRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxDQUFDO2FBQzNDO1lBQ0QsS0FBSyxFQUFFLFNBQVM7U0FDakIsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBbEpELDRDQWtKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gIEFybixcbiAgQXJuRm9ybWF0LFxuICBEdXJhdGlvbixcbiAgU3RhY2ssXG4gIFN0YWNrUHJvcHMsXG4gIGF3c19pYW0sXG4gIGF3c19sYW1iZGEsXG4gIGF3c19sYW1iZGFfbm9kZWpzLFxuICBhd3Nfc2NoZWR1bGVyLFxufSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIG5lcHR1bmUgZnJvbSBcIkBhd3MtY2RrL2F3cy1uZXB0dW5lLWFscGhhXCI7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tIFwiY2RrLW5hZ1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcInBhdGhcIjtcblxuaW50ZXJmYWNlIE5lcHR1bmVTY2hlZHVsZXJQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICBjbHVzdGVyOiBuZXB0dW5lLkRhdGFiYXNlQ2x1c3RlcjtcbiAgLyoqIElBTkEgdGltZXpvbmUgZm9yIHRoZSBzY2hlZHVsZSAoZGVmYXVsdDogQW1lcmljYS9Mb3NfQW5nZWxlcykgKi9cbiAgdGltZXpvbmU/OiBzdHJpbmc7XG4gIC8qKiBDcm9uIGhvdXIgKDAtMjMpIHRvIHN0b3AgdGhlIGNsdXN0ZXIgaW4gdGhlIGdpdmVuIHRpbWV6b25lIChkZWZhdWx0OiAwID0gbWlkbmlnaHQpICovXG4gIHN0b3BIb3VyPzogbnVtYmVyO1xuICAvKiogQ3JvbiBob3VyICgwLTIzKSB0byBzdGFydCB0aGUgY2x1c3RlciBpbiB0aGUgZ2l2ZW4gdGltZXpvbmUgKGRlZmF1bHQ6IDE2ID0gNHBtKSAqL1xuICBzdGFydEhvdXI/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBOZXB0dW5lU2NoZWR1bGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IE5lcHR1bmVTY2hlZHVsZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCB7XG4gICAgICBjbHVzdGVyLFxuICAgICAgdGltZXpvbmUgPSBcIkFtZXJpY2EvTG9zX0FuZ2VsZXNcIixcbiAgICAgIHN0b3BIb3VyID0gMCxcbiAgICAgIHN0YXJ0SG91ciA9IDE2LFxuICAgIH0gPSBwcm9wcztcblxuICAgIC8vIFRoZSBMMiBjbHVzdGVyIGRvZXNuJ3QgZXhwb3NlIGNsdXN0ZXJJZGVudGlmaWVyIGRpcmVjdGx5IG9uIHRoZSB0eXBlLFxuICAgIC8vIGJ1dCB0aGUgdW5kZXJseWluZyBDRk4gcmVzb3VyY2UgaGFzIGl0LiBVc2UgY2x1c3RlclJlc291cmNlSWRlbnRpZmllclxuICAgIC8vIHZpYSB0aGUgY2x1c3RlciBlbmRwb2ludCBhZGRyZXNzIHRvIGRlcml2ZSBpdCwgb3IgdXNlIEZuOjpTZWxlY3QuXG4gICAgY29uc3QgY2x1c3RlcklkZW50aWZpZXIgPSBjbHVzdGVyLmNsdXN0ZXJJZGVudGlmaWVyO1xuXG4gICAgLy8gQ29uc3RydWN0IHRoZSBjbHVzdGVyIEFSTiAobm90IGV4cG9zZWQgYnkgdGhlIEwyIGNvbnN0cnVjdClcbiAgICBjb25zdCBjbHVzdGVyQXJuID0gQXJuLmZvcm1hdChcbiAgICAgIHtcbiAgICAgICAgc2VydmljZTogXCJyZHNcIixcbiAgICAgICAgcmVzb3VyY2U6IFwiY2x1c3RlclwiLFxuICAgICAgICByZXNvdXJjZU5hbWU6IGNsdXN0ZXJJZGVudGlmaWVyLFxuICAgICAgICBhcm5Gb3JtYXQ6IEFybkZvcm1hdC5DT0xPTl9SRVNPVVJDRV9OQU1FLFxuICAgICAgfSxcbiAgICAgIFN0YWNrLm9mKHRoaXMpXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gTGFtYmRhIHRoYXQgc3RvcHMgLyBzdGFydHMgdGhlIE5lcHR1bmUgY2x1c3RlclxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgY29uc3Qgc2NoZWR1bGVyRm4gPSBuZXcgYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJuZXB0dW5lLXNjaGVkdWxlci1mblwiLFxuICAgICAge1xuICAgICAgICBydW50aW1lOiBhd3NfbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzI0X1gsXG4gICAgICAgIGVudHJ5OiBwYXRoLmpvaW4oXG4gICAgICAgICAgX19kaXJuYW1lLFxuICAgICAgICAgIFwiLi5cIixcbiAgICAgICAgICBcIi4uXCIsXG4gICAgICAgICAgXCJhcGlcIixcbiAgICAgICAgICBcImxhbWJkYVwiLFxuICAgICAgICAgIFwibmVwdHVuZVNjaGVkdWxlclwiLFxuICAgICAgICAgIFwiaW5kZXgudHNcIlxuICAgICAgICApLFxuICAgICAgICBoYW5kbGVyOiBcImhhbmRsZXJcIixcbiAgICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9DTFVTVEVSX0lEOiBjbHVzdGVySWRlbnRpZmllcixcbiAgICAgICAgfSxcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFtcIkBhd3Mtc2RrLypcIl0sICAvLyB1c2UgU0RLIHYzIGZyb20gTGFtYmRhIHJ1bnRpbWVcbiAgICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBHcmFudCB0aGUgTGFtYmRhIHBlcm1pc3Npb24gdG8gc3RvcC9zdGFydCB0aGUgTmVwdHVuZSBjbHVzdGVyXG4gICAgc2NoZWR1bGVyRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBhd3NfaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwicmRzOlN0b3BEQkNsdXN0ZXJcIixcbiAgICAgICAgICBcInJkczpTdGFydERCQ2x1c3RlclwiLFxuICAgICAgICAgIFwicmRzOkRlc2NyaWJlREJDbHVzdGVyc1wiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtjbHVzdGVyQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gRXZlbnRCcmlkZ2UgU2NoZWR1bGVyIHJvbGVcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIGNvbnN0IHNjaGVkdWxlclJvbGUgPSBuZXcgYXdzX2lhbS5Sb2xlKHRoaXMsIFwic2NoZWR1bGVyLXJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgYXdzX2lhbS5TZXJ2aWNlUHJpbmNpcGFsKFwic2NoZWR1bGVyLmFtYXpvbmF3cy5jb21cIiksXG4gICAgfSk7XG4gICAgc2NoZWR1bGVyRm4uZ3JhbnRJbnZva2Uoc2NoZWR1bGVyUm9sZSk7XG5cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIGNkay1uYWcgc3VwcHJlc3Npb25zXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoXG4gICAgICBzY2hlZHVsZXJGbixcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU00XCIsXG4gICAgICAgICAgcmVhc29uOlxuICAgICAgICAgICAgXCJBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgcmVxdWlyZWQgZm9yIENsb3VkV2F0Y2ggTG9ncyBhY2Nlc3NcIixcbiAgICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICAgIFwiUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtTDFcIixcbiAgICAgICAgICByZWFzb246IFwiTk9ERUpTXzIyX1ggaXMgdGhlIGxhdGVzdCBzdXBwb3J0ZWQgcnVudGltZSBhdCBkZXBsb3kgdGltZVwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKFxuICAgICAgc2NoZWR1bGVyUm9sZSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgICAgcmVhc29uOlxuICAgICAgICAgICAgXCJXaWxkY2FyZCBvbiBMYW1iZGEgQVJOIHZlcnNpb24gaXMgcmVxdWlyZWQgYnkgZ3JhbnRJbnZva2UgZm9yIEV2ZW50QnJpZGdlIFNjaGVkdWxlclwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBTY2hlZHVsZXMgKHRpbWV6b25lLWF3YXJlIHZpYSBFdmVudEJyaWRnZSBTY2hlZHVsZXIpXG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIFN0b3AgTmVwdHVuZSBhdCB0aGUgY29uZmlndXJlZCBob3VyIChkZWZhdWx0OiBtaWRuaWdodCBQYWNpZmljKVxuICAgIG5ldyBhd3Nfc2NoZWR1bGVyLkNmblNjaGVkdWxlKHRoaXMsIFwic3RvcC1zY2hlZHVsZVwiLCB7XG4gICAgICBuYW1lOiBcIm5lcHR1bmUtc3RvcC1zY2hlZHVsZVwiLFxuICAgICAgZGVzY3JpcHRpb246IGBTdG9wIE5lcHR1bmUgY2x1c3RlciBhdCAke3N0b3BIb3VyfTowMCAke3RpbWV6b25lfWAsXG4gICAgICBzY2hlZHVsZUV4cHJlc3Npb25UaW1lem9uZTogdGltZXpvbmUsXG4gICAgICBzY2hlZHVsZUV4cHJlc3Npb246IGBjcm9uKDAgJHtzdG9wSG91cn0gKiAqID8gKilgLFxuICAgICAgZmxleGlibGVUaW1lV2luZG93OiB7IG1vZGU6IFwiT0ZGXCIgfSxcbiAgICAgIHRhcmdldDoge1xuICAgICAgICBhcm46IHNjaGVkdWxlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgICByb2xlQXJuOiBzY2hlZHVsZXJSb2xlLnJvbGVBcm4sXG4gICAgICAgIGlucHV0OiBKU09OLnN0cmluZ2lmeSh7IGFjdGlvbjogXCJzdG9wXCIgfSksXG4gICAgICB9LFxuICAgICAgc3RhdGU6IFwiRU5BQkxFRFwiLFxuICAgIH0pO1xuXG4gICAgLy8gU3RhcnQgTmVwdHVuZSBhdCB0aGUgY29uZmlndXJlZCBob3VyIChkZWZhdWx0OiA0cG0gUGFjaWZpYylcbiAgICBuZXcgYXdzX3NjaGVkdWxlci5DZm5TY2hlZHVsZSh0aGlzLCBcInN0YXJ0LXNjaGVkdWxlXCIsIHtcbiAgICAgIG5hbWU6IFwibmVwdHVuZS1zdGFydC1zY2hlZHVsZVwiLFxuICAgICAgZGVzY3JpcHRpb246IGBTdGFydCBOZXB0dW5lIGNsdXN0ZXIgYXQgJHtzdGFydEhvdXJ9OjAwICR7dGltZXpvbmV9YCxcbiAgICAgIHNjaGVkdWxlRXhwcmVzc2lvblRpbWV6b25lOiB0aW1lem9uZSxcbiAgICAgIHNjaGVkdWxlRXhwcmVzc2lvbjogYGNyb24oMCAke3N0YXJ0SG91cn0gKiAqID8gKilgLFxuICAgICAgZmxleGlibGVUaW1lV2luZG93OiB7IG1vZGU6IFwiT0ZGXCIgfSxcbiAgICAgIHRhcmdldDoge1xuICAgICAgICBhcm46IHNjaGVkdWxlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgICByb2xlQXJuOiBzY2hlZHVsZXJSb2xlLnJvbGVBcm4sXG4gICAgICAgIGlucHV0OiBKU09OLnN0cmluZ2lmeSh7IGFjdGlvbjogXCJzdGFydFwiIH0pLFxuICAgICAgfSxcbiAgICAgIHN0YXRlOiBcIkVOQUJMRURcIixcbiAgICB9KTtcbiAgfVxufVxuIl19