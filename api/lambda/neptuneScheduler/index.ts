import { NeptuneClient, StopDBClusterCommand, StartDBClusterCommand } from "@aws-sdk/client-neptune";

const client = new NeptuneClient({});
const CLUSTER_ID = process.env.NEPTUNE_CLUSTER_ID!;

export const handler = async (event: { action: "stop" | "start" }) => {
  const { action } = event;
  console.log(`Neptune scheduler: ${action} cluster ${CLUSTER_ID}`);

  try {
    if (action === "stop") {
      await client.send(new StopDBClusterCommand({ DBClusterIdentifier: CLUSTER_ID }));
      console.log(`Cluster ${CLUSTER_ID} stop initiated`);
    } else if (action === "start") {
      await client.send(new StartDBClusterCommand({ DBClusterIdentifier: CLUSTER_ID }));
      console.log(`Cluster ${CLUSTER_ID} start initiated`);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    return { statusCode: 200, body: `${action} initiated for ${CLUSTER_ID}` };
  } catch (error: any) {
    // If cluster is already in the desired state, treat as success
    if (
      error.name === "InvalidDBClusterStateFault" ||
      error.name === "InvalidClusterStateFault"
    ) {
      console.log(`Cluster already in desired state for action: ${action}`);
      return { statusCode: 200, body: `Cluster already ${action === "stop" ? "stopped" : "running"}` };
    }
    console.error(`Failed to ${action} cluster:`, error);
    throw error;
  }
};
