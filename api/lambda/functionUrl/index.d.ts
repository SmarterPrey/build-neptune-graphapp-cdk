/// <reference types="node" />
import { Handler } from "aws-lambda";
declare global {
    namespace awslambda {
        function streamifyResponse(f: (event: any, responseStream: NodeJS.WritableStream) => Promise<void>): Handler;
    }
}
export declare const handler: Handler;
