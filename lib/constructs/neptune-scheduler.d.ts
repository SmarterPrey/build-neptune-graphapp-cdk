import { StackProps } from "aws-cdk-lib";
import * as neptune from "@aws-cdk/aws-neptune-alpha";
import { Construct } from "constructs";
interface NeptuneSchedulerProps extends StackProps {
    cluster: neptune.DatabaseCluster;
    /** IANA timezone for the schedule (default: America/Los_Angeles) */
    timezone?: string;
    /** Cron hour (0-23) to stop the cluster in the given timezone (default: 0 = midnight) */
    stopHour?: number;
    /** Cron hour (0-23) to start the cluster in the given timezone (default: 16 = 4pm) */
    startHour?: number;
}
export declare class NeptuneScheduler extends Construct {
    constructor(scope: Construct, id: string, props: NeptuneSchedulerProps);
}
export {};
