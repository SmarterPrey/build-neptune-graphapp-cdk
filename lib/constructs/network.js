"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Network = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk_nag_1 = require("cdk-nag");
const constructs_1 = require("constructs");
class Network extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { natSubnet, maxAz } = props;
        const cwLogs = new aws_cdk_lib_1.aws_logs.LogGroup(this, "vpc-logs", {
            logGroupName: `/${id}/vpc-logs/`,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            retention: aws_cdk_lib_1.aws_logs.RetentionDays.TWO_MONTHS,
        });
        const subnetConfiguration = [
            {
                subnetType: aws_cdk_lib_1.aws_ec2.SubnetType.PUBLIC,
                name: "public-subnet",
            },
            {
                subnetType: aws_cdk_lib_1.aws_ec2.SubnetType.PRIVATE_ISOLATED,
                name: "neptune-isolated-subnet",
            },
        ];
        if (natSubnet) {
            subnetConfiguration.push({
                subnetType: aws_cdk_lib_1.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
                name: "nat-subnet",
            });
        }
        const vpcBaseProps = {
            maxAzs: maxAz,
            subnetConfiguration,
            flowLogs: {
                s3: {
                    destination: aws_cdk_lib_1.aws_ec2.FlowLogDestination.toCloudWatchLogs(cwLogs),
                    trafficType: aws_cdk_lib_1.aws_ec2.FlowLogTrafficType.ALL,
                },
            },
            gatewayEndpoints: {
                S3: {
                    service: aws_cdk_lib_1.aws_ec2.GatewayVpcEndpointAwsService.S3,
                },
            },
        };
        if (props.natSubnet) {
            const eipAllocationForNat = [];
            const eipAllocationIds = [];
            for (let i = 0; i < maxAz; i++) {
                const eip = new aws_cdk_lib_1.aws_ec2.CfnEIP(this, `${id}-nat-eip${i}`, {});
                eipAllocationForNat.push(eip.attrPublicIp);
                eipAllocationIds.push(eip.attrAllocationId);
            }
            vpcBaseProps.natGatewayProvider = aws_cdk_lib_1.aws_ec2.NatProvider.gateway({
                eipAllocationIds,
            });
        }
        const vpcProps = vpcBaseProps;
        this.vpc = new aws_cdk_lib_1.aws_ec2.Vpc(this, "vpc", vpcProps);
        // Create endpoint
        const CWEndpoint = new aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpoint(this, "cw-vep", {
            service: aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
            vpc: this.vpc,
            privateDnsEnabled: true,
        });
        const CWLEndpoint = new aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpoint(this, "cwl-vep", {
            service: aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            vpc: this.vpc,
            privateDnsEnabled: true,
        });
        const bedrockEndpoint = new aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpoint(this, "bedrock-vep", {
            service: aws_cdk_lib_1.aws_ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
            vpc: this.vpc,
            privateDnsEnabled: true,
        });
        // Nag supressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions([CWEndpoint, CWLEndpoint, bedrockEndpoint], [
            {
                id: "CdkNagValidationFailure",
                reason: "Suppressed: Managed by privatelink construct",
            },
        ], true);
    }
}
exports.Network = Network;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmV0d29yay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm5ldHdvcmsudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkNBQTJFO0FBQzNFLHFDQUEwQztBQUUxQywyQ0FBdUM7QUFNdkMsTUFBYSxPQUFRLFNBQVEsc0JBQVM7SUFFcEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFtQjtRQUMzRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pCLE1BQU0sRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBRW5DLE1BQU0sTUFBTSxHQUFHLElBQUksc0JBQVEsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUNyRCxZQUFZLEVBQUUsSUFBSSxFQUFFLFlBQVk7WUFDaEMsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztZQUNwQyxTQUFTLEVBQUUsc0JBQVEsQ0FBQyxhQUFhLENBQUMsVUFBVTtTQUM3QyxDQUFDLENBQUM7UUFFSCxNQUFNLG1CQUFtQixHQUFrQztZQUN6RDtnQkFDRSxVQUFVLEVBQUUscUJBQU8sQ0FBQyxVQUFVLENBQUMsTUFBTTtnQkFDckMsSUFBSSxFQUFFLGVBQWU7YUFDdEI7WUFDRDtnQkFDRSxVQUFVLEVBQUUscUJBQU8sQ0FBQyxVQUFVLENBQUMsZ0JBQWdCO2dCQUMvQyxJQUFJLEVBQUUseUJBQXlCO2FBQ2hDO1NBQ0YsQ0FBQztRQUVGLElBQUksU0FBUyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsQ0FBQyxJQUFJLENBQUM7Z0JBQ3ZCLFVBQVUsRUFBRSxxQkFBTyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7Z0JBQ2xELElBQUksRUFBRSxZQUFZO2FBQ25CLENBQUMsQ0FBQztRQUNMLENBQUM7UUFFRCxNQUFNLFlBQVksR0FBUTtZQUN4QixNQUFNLEVBQUUsS0FBSztZQUNiLG1CQUFtQjtZQUNuQixRQUFRLEVBQUU7Z0JBQ1IsRUFBRSxFQUFFO29CQUNGLFdBQVcsRUFBRSxxQkFBTyxDQUFDLGtCQUFrQixDQUFDLGdCQUFnQixDQUFDLE1BQU0sQ0FBQztvQkFDaEUsV0FBVyxFQUFFLHFCQUFPLENBQUMsa0JBQWtCLENBQUMsR0FBRztpQkFDNUM7YUFDRjtZQUNELGdCQUFnQixFQUFFO2dCQUNoQixFQUFFLEVBQUU7b0JBQ0YsT0FBTyxFQUFFLHFCQUFPLENBQUMsNEJBQTRCLENBQUMsRUFBRTtpQkFDakQ7YUFDRjtTQUNGLENBQUM7UUFDRixJQUFJLEtBQUssQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNwQixNQUFNLG1CQUFtQixHQUFHLEVBQUUsQ0FBQztZQUMvQixNQUFNLGdCQUFnQixHQUFhLEVBQUUsQ0FBQztZQUV0QyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7Z0JBQy9CLE1BQU0sR0FBRyxHQUFHLElBQUkscUJBQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLEdBQUcsRUFBRSxXQUFXLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO2dCQUM5RCxtQkFBbUIsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO2dCQUMzQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7WUFDOUMsQ0FBQztZQUVELFlBQVksQ0FBQyxrQkFBa0IsR0FBRyxxQkFBTyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUM7Z0JBQzVELGdCQUFnQjthQUNqQixDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQXFCLFlBQVksQ0FBQztRQUNoRCxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUkscUJBQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsQ0FBQztRQUVsRCxrQkFBa0I7UUFDbEIsTUFBTSxVQUFVLEdBQUcsSUFBSSxxQkFBTyxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDbEUsT0FBTyxFQUFFLHFCQUFPLENBQUMsOEJBQThCLENBQUMscUJBQXFCO1lBQ3JFLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxXQUFXLEdBQUcsSUFBSSxxQkFBTyxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEUsT0FBTyxFQUFFLHFCQUFPLENBQUMsOEJBQThCLENBQUMsZUFBZTtZQUMvRCxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDYixpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILE1BQU0sZUFBZSxHQUFHLElBQUkscUJBQU8sQ0FBQyxvQkFBb0IsQ0FDdEQsSUFBSSxFQUNKLGFBQWEsRUFDYjtZQUNFLE9BQU8sRUFBRSxxQkFBTyxDQUFDLDhCQUE4QixDQUFDLGVBQWU7WUFDL0QsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHO1lBQ2IsaUJBQWlCLEVBQUUsSUFBSTtTQUN4QixDQUNGLENBQUM7UUFFRixrQkFBa0I7UUFDbEIseUJBQWUsQ0FBQyx1QkFBdUIsQ0FDckMsQ0FBQyxVQUFVLEVBQUUsV0FBVyxFQUFFLGVBQWUsQ0FBQyxFQUMxQztZQUNFO2dCQUNFLEVBQUUsRUFBRSx5QkFBeUI7Z0JBQzdCLE1BQU0sRUFBRSw4Q0FBOEM7YUFDdkQ7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBbEdELDBCQWtHQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrUHJvcHMsIGF3c19lYzIsIGF3c19sb2dzIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tIFwiY2RrLW5hZ1wiO1xuXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbnRlcmZhY2UgTmV0d29ya1Byb3BzIGV4dGVuZHMgU3RhY2tQcm9wcyB7XG4gIG5hdFN1Ym5ldD86IGJvb2xlYW47XG4gIG1heEF6OiBudW1iZXI7XG59XG5leHBvcnQgY2xhc3MgTmV0d29yayBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSB2cGM6IGF3c19lYzIuVnBjO1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogTmV0d29ya1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcbiAgICBjb25zdCB7IG5hdFN1Ym5ldCwgbWF4QXogfSA9IHByb3BzO1xuXG4gICAgY29uc3QgY3dMb2dzID0gbmV3IGF3c19sb2dzLkxvZ0dyb3VwKHRoaXMsIFwidnBjLWxvZ3NcIiwge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgLyR7aWR9L3ZwYy1sb2dzL2AsXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICByZXRlbnRpb246IGF3c19sb2dzLlJldGVudGlvbkRheXMuVFdPX01PTlRIUyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN1Ym5ldENvbmZpZ3VyYXRpb246IGF3c19lYzIuU3VibmV0Q29uZmlndXJhdGlvbltdID0gW1xuICAgICAge1xuICAgICAgICBzdWJuZXRUeXBlOiBhd3NfZWMyLlN1Ym5ldFR5cGUuUFVCTElDLFxuICAgICAgICBuYW1lOiBcInB1YmxpYy1zdWJuZXRcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGF3c19lYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICBuYW1lOiBcIm5lcHR1bmUtaXNvbGF0ZWQtc3VibmV0XCIsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBpZiAobmF0U3VibmV0KSB7XG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uLnB1c2goe1xuICAgICAgICBzdWJuZXRUeXBlOiBhd3NfZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgbmFtZTogXCJuYXQtc3VibmV0XCIsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCB2cGNCYXNlUHJvcHM6IGFueSA9IHtcbiAgICAgIG1heEF6czogbWF4QXosXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uLFxuICAgICAgZmxvd0xvZ3M6IHtcbiAgICAgICAgczM6IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbjogYXdzX2VjMi5GbG93TG9nRGVzdGluYXRpb24udG9DbG91ZFdhdGNoTG9ncyhjd0xvZ3MpLFxuICAgICAgICAgIHRyYWZmaWNUeXBlOiBhd3NfZWMyLkZsb3dMb2dUcmFmZmljVHlwZS5BTEwsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgZ2F0ZXdheUVuZHBvaW50czoge1xuICAgICAgICBTMzoge1xuICAgICAgICAgIHNlcnZpY2U6IGF3c19lYzIuR2F0ZXdheVZwY0VuZHBvaW50QXdzU2VydmljZS5TMyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBpZiAocHJvcHMubmF0U3VibmV0KSB7XG4gICAgICBjb25zdCBlaXBBbGxvY2F0aW9uRm9yTmF0ID0gW107XG4gICAgICBjb25zdCBlaXBBbGxvY2F0aW9uSWRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heEF6OyBpKyspIHtcbiAgICAgICAgY29uc3QgZWlwID0gbmV3IGF3c19lYzIuQ2ZuRUlQKHRoaXMsIGAke2lkfS1uYXQtZWlwJHtpfWAsIHt9KTtcbiAgICAgICAgZWlwQWxsb2NhdGlvbkZvck5hdC5wdXNoKGVpcC5hdHRyUHVibGljSXApO1xuICAgICAgICBlaXBBbGxvY2F0aW9uSWRzLnB1c2goZWlwLmF0dHJBbGxvY2F0aW9uSWQpO1xuICAgICAgfVxuXG4gICAgICB2cGNCYXNlUHJvcHMubmF0R2F0ZXdheVByb3ZpZGVyID0gYXdzX2VjMi5OYXRQcm92aWRlci5nYXRld2F5KHtcbiAgICAgICAgZWlwQWxsb2NhdGlvbklkcyxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHZwY1Byb3BzOiBhd3NfZWMyLlZwY1Byb3BzID0gdnBjQmFzZVByb3BzO1xuICAgIHRoaXMudnBjID0gbmV3IGF3c19lYzIuVnBjKHRoaXMsIFwidnBjXCIsIHZwY1Byb3BzKTtcblxuICAgIC8vIENyZWF0ZSBlbmRwb2ludFxuICAgIGNvbnN0IENXRW5kcG9pbnQgPSBuZXcgYXdzX2VjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCh0aGlzLCBcImN3LXZlcFwiLCB7XG4gICAgICBzZXJ2aWNlOiBhd3NfZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX01PTklUT1JJTkcsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBDV0xFbmRwb2ludCA9IG5ldyBhd3NfZWMyLkludGVyZmFjZVZwY0VuZHBvaW50KHRoaXMsIFwiY3dsLXZlcFwiLCB7XG4gICAgICBzZXJ2aWNlOiBhd3NfZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX0xPR1MsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBiZWRyb2NrRW5kcG9pbnQgPSBuZXcgYXdzX2VjMi5JbnRlcmZhY2VWcGNFbmRwb2ludChcbiAgICAgIHRoaXMsXG4gICAgICBcImJlZHJvY2stdmVwXCIsXG4gICAgICB7XG4gICAgICAgIHNlcnZpY2U6IGF3c19lYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLkJFRFJPQ0tfUlVOVElNRSxcbiAgICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIE5hZyBzdXByZXNzaW9uc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIFtDV0VuZHBvaW50LCBDV0xFbmRwb2ludCwgYmVkcm9ja0VuZHBvaW50XSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkNka05hZ1ZhbGlkYXRpb25GYWlsdXJlXCIsXG4gICAgICAgICAgcmVhc29uOiBcIlN1cHByZXNzZWQ6IE1hbmFnZWQgYnkgcHJpdmF0ZWxpbmsgY29uc3RydWN0XCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgdHJ1ZVxuICAgICk7XG4gIH1cbn1cbiJdfQ==