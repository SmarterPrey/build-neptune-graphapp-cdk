import { Stack, StackProps, aws_ec2, aws_iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as neptune from "@aws-cdk/aws-neptune-alpha";
import { Network } from "./constructs/network";
import { Neptune } from "./constructs/neptune";
import { NeptuneScheduler } from "./constructs/neptune-scheduler";

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
  }
}
