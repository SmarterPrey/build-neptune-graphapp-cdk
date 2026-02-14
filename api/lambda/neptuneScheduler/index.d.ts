export declare const handler: (event: {
    action: "stop" | "start";
}) => Promise<{
    statusCode: number;
    body: string;
}>;
