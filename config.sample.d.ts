import { RemovalPolicy } from "aws-cdk-lib";
declare const deployConfig: {
    stage: string;
    appName: string;
    region: string;
    adminEmail: string;
    allowedIps: never[];
    wafParamName: string;
    webBucketsRemovalPolicy: RemovalPolicy;
    s3Uri: {
        edge: string;
        vertex: string;
    };
};
export { deployConfig };
