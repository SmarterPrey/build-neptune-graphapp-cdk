import { Construct } from "constructs";
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
export declare class ParameterEmailSubscriber extends Construct {
    constructor(scope: Construct, id: string, props: ParameterEmailSubscriberProps);
}
