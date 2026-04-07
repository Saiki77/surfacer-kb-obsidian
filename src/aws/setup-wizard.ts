/**
 * One-click AWS setup wizard.
 * Creates S3 bucket + CloudFormation collab stack from within Obsidian.
 */

import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { fromIni } from "@aws-sdk/credential-providers";
import type { KBSyncSettings } from "../settings";

export interface SetupResult {
  bucketName: string;
  wsUrl: string;
  stackName: string;
}

export interface JoinResult {
  wsUrl: string;
}

const STACK_NAME = "kb-collab";

function getCredentials(settings: KBSyncSettings) {
  return settings.credentialMode === "profile"
    ? fromIni({ profile: settings.awsProfile })
    : {
        accessKeyId: settings.awsAccessKeyId,
        secretAccessKey: settings.awsSecretAccessKey,
      };
}

function randomHex(len: number): string {
  const chars = "abcdef0123456789";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Create a new team: S3 bucket + CloudFormation collab stack.
 */
export async function setupNewTeam(
  settings: KBSyncSettings,
  onProgress: (msg: string) => void
): Promise<SetupResult> {
  const credentials = getCredentials(settings);
  const region = settings.awsRegion;

  const s3 = new S3Client({ region, credentials });
  const cfn = new CloudFormationClient({ region, credentials });

  // Step 1: Create S3 bucket
  const bucketName = `kb-${randomHex(6)}-${region}`;
  onProgress("Creating S3 bucket...");

  const createBucketParams: any = { Bucket: bucketName };
  if (region !== "us-east-1") {
    createBucketParams.CreateBucketConfiguration = {
      LocationConstraint: region,
    };
  }
  await s3.send(new CreateBucketCommand(createBucketParams));

  // Step 2: Enable versioning
  onProgress("Enabling bucket versioning...");
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: "Enabled" },
    })
  );

  // Step 3: Deploy CloudFormation stack
  onProgress("Deploying collaboration infrastructure...");
  await cfn.send(
    new CreateStackCommand({
      StackName: STACK_NAME,
      TemplateBody: COLLAB_TEMPLATE,
      Capabilities: ["CAPABILITY_IAM"],
    })
  );

  // Step 4: Wait for stack creation (poll every 5s, max 3 min)
  let wsUrl = "";
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const elapsed = (i + 1) * 5;
    onProgress(`Deploying infrastructure... (${elapsed}s)`);

    const result = await cfn.send(
      new DescribeStacksCommand({ StackName: STACK_NAME })
    );
    const stack = result.Stacks?.[0];
    if (!stack) continue;

    if (stack.StackStatus === "CREATE_COMPLETE") {
      wsUrl =
        stack.Outputs?.find((o) => o.OutputKey === "WebSocketUrl")
          ?.OutputValue || "";
      break;
    }

    if (
      stack.StackStatus === "CREATE_FAILED" ||
      stack.StackStatus === "ROLLBACK_COMPLETE" ||
      stack.StackStatus === "ROLLBACK_IN_PROGRESS"
    ) {
      throw new Error(
        `Stack creation failed: ${stack.StackStatusReason || stack.StackStatus}`
      );
    }
  }

  if (!wsUrl) {
    throw new Error("Stack creation timed out after 3 minutes");
  }

  onProgress("Setup complete!");
  return { bucketName, wsUrl, stackName: STACK_NAME };
}

/**
 * Join an existing team: verify bucket access and discover WebSocket URL.
 */
export async function joinExistingTeam(
  settings: KBSyncSettings
): Promise<JoinResult> {
  const credentials = getCredentials(settings);
  const region = settings.awsRegion;

  // Verify bucket access
  const s3 = new S3Client({ region, credentials });
  await s3.send(new HeadBucketCommand({ Bucket: settings.s3Bucket }));

  // Discover WebSocket URL from CloudFormation stack
  const cfn = new CloudFormationClient({ region, credentials });
  const result = await cfn.send(
    new DescribeStacksCommand({ StackName: STACK_NAME })
  );
  const stack = result.Stacks?.[0];
  if (!stack || stack.StackStatus !== "CREATE_COMPLETE") {
    throw new Error(
      "Collaboration stack not found. Ask your team admin for the WebSocket URL."
    );
  }

  const wsUrl =
    stack.Outputs?.find((o) => o.OutputKey === "WebSocketUrl")?.OutputValue ||
    "";
  if (!wsUrl) {
    throw new Error("WebSocket URL not found in stack outputs.");
  }

  return { wsUrl };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Embedded CloudFormation Template ─────────────────
// This is the same as infra/collab-stack.yaml, embedded as a string
// so it works in the bundled plugin without filesystem access.

const COLLAB_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: "Live Collaboration WebSocket infrastructure for KB S3 Sync"

Parameters:
  StageName:
    Type: String
    Default: prod
    Description: API Gateway stage name

Resources:
  ConnectionsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub "\${AWS::StackName}-connections"
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: connectionId
          AttributeType: S
        - AttributeName: docPath
          AttributeType: S
      KeySchema:
        - AttributeName: connectionId
          KeyType: HASH
      GlobalSecondaryIndexes:
        - IndexName: docPath-index
          KeySchema:
            - AttributeName: docPath
              KeyType: HASH
            - AttributeName: connectionId
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true

  LambdaRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: DynamoDBAccess
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action:
                  - dynamodb:PutItem
                  - dynamodb:GetItem
                  - dynamodb:DeleteItem
                  - dynamodb:Query
                  - dynamodb:UpdateItem
                Resource:
                  - !GetAtt ConnectionsTable.Arn
                  - !Sub "\${ConnectionsTable.Arn}/index/*"
        - PolicyName: ApiGatewayManageConnections
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action:
                  - execute-api:ManageConnections
                Resource:
                  - !Sub "arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${WebSocketApi}/*"

  CollabHandler:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Sub "\${AWS::StackName}-handler"
      Runtime: nodejs20.x
      Handler: index.handler
      Architectures:
        - arm64
      MemorySize: 128
      Timeout: 10
      Role: !GetAtt LambdaRole.Arn
      Environment:
        Variables:
          TABLE_NAME: !Ref ConnectionsTable
      Code:
        ZipFile: |
          const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
          const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
          const ddb = new DynamoDBClient({});
          const TABLE = process.env.TABLE_NAME;
          exports.handler = async (event) => {
            const { requestContext, body } = event;
            const connectionId = requestContext.connectionId;
            const routeKey = requestContext.routeKey;
            const endpoint = \`https://\${requestContext.domainName}/\${requestContext.stage}\`;
            try {
              if (routeKey === "$connect") {
                const ttl = Math.floor(Date.now() / 1000) + 86400;
                await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { connectionId: { S: connectionId }, docPath: { S: "__unsubscribed__" }, userId: { S: "" }, connectedAt: { S: new Date().toISOString() }, ttl: { N: String(ttl) } } }));
                return { statusCode: 200, body: "Connected" };
              }
              if (routeKey === "$disconnect") {
                await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { connectionId: { S: connectionId } } }));
                return { statusCode: 200, body: "Disconnected" };
              }
              const msg = JSON.parse(body);
              const apigw = new ApiGatewayManagementApiClient({ endpoint });
              if (msg.action === "subscribe" || msg.action === "unsubscribe") {
                const ttl = Math.floor(Date.now() / 1000) + 86400;
                const docPath = msg.action === "subscribe" ? msg.docPath : "__unsubscribed__";
                await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { connectionId: { S: connectionId }, docPath: { S: docPath }, userId: { S: msg.userId || "" }, connectedAt: { S: new Date().toISOString() }, ttl: { N: String(ttl) } } }));
                return { statusCode: 200, body: msg.action };
              }
              if (msg.action === "ping") {
                await apigw.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify({ action: "pong", ts: msg.ts }) }));
                return { statusCode: 200, body: "Pong" };
              }
              if (msg.docPath && ["update", "cursor", "sync-vector", "sync-diff", "review", "permission"].includes(msg.action)) {
                const result = await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: "docPath-index", KeyConditionExpression: "docPath = :dp", ExpressionAttributeValues: { ":dp": { S: msg.docPath } } }));
                const peers = (result.Items || []).filter(item => item.connectionId.S !== connectionId);
                const payload = JSON.stringify(msg);
                const stale = [];
                await Promise.all(peers.map(async (peer) => { try { await apigw.send(new PostToConnectionCommand({ ConnectionId: peer.connectionId.S, Data: payload })); } catch (err) { if (err.statusCode === 410) stale.push(peer.connectionId.S); } }));
                await Promise.all(stale.map(id => ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { connectionId: { S: id } } }))));
                return { statusCode: 200, body: "Broadcast" };
              }
              return { statusCode: 200, body: "OK" };
            } catch (err) { console.error(err); return { statusCode: 500, body: "Error" }; }
          };

  WebSocketApi:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      Name: !Sub "\${AWS::StackName}-ws"
      ProtocolType: WEBSOCKET
      RouteSelectionExpression: "$request.body.action"

  LambdaIntegration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref WebSocketApi
      IntegrationType: AWS_PROXY
      IntegrationUri: !Sub "arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${CollabHandler.Arn}/invocations"

  ConnectRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref WebSocketApi
      RouteKey: "$connect"
      Target: !Sub "integrations/\${LambdaIntegration}"

  DisconnectRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref WebSocketApi
      RouteKey: "$disconnect"
      Target: !Sub "integrations/\${LambdaIntegration}"

  DefaultRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref WebSocketApi
      RouteKey: "$default"
      Target: !Sub "integrations/\${LambdaIntegration}"

  Deployment:
    Type: AWS::ApiGatewayV2::Deployment
    DependsOn:
      - ConnectRoute
      - DisconnectRoute
      - DefaultRoute
    Properties:
      ApiId: !Ref WebSocketApi

  Stage:
    Type: AWS::ApiGatewayV2::Stage
    Properties:
      ApiId: !Ref WebSocketApi
      StageName: !Ref StageName
      DeploymentId: !Ref Deployment

  LambdaPermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref CollabHandler
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub "arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${WebSocketApi}/*"

Outputs:
  WebSocketUrl:
    Description: "WebSocket URL for the collaboration endpoint"
    Value: !Sub "wss://\${WebSocketApi}.execute-api.\${AWS::Region}.amazonaws.com/\${StageName}"
    Export:
      Name: !Sub "\${AWS::StackName}-ws-url"
  ConnectionsTableName:
    Description: "DynamoDB table name"
    Value: !Ref ConnectionsTable`;
