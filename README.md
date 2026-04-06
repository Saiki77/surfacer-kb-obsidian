# Knowledge Base S3 Sync for Obsidian

Bidirectional sync between your Obsidian vault and an S3-backed knowledge base with **real-time live collaboration**. Built for small teams that want Google Docs-style co-editing, team presence, chat, version history, and hand-offs — all powered by AWS serverless infrastructure.

## Features

### Live Collaboration
- **Real-time co-editing** — two or more people editing the same document simultaneously with automatic conflict-free merging via Yjs CRDT
- **Remote cursors** — see where your teammates are typing with colored cursor indicators and name labels
- **Live collaborator bar** — pulsing green indicator and user avatars when someone else is in your document
- **Automatic activation** — collaboration starts the moment you open a synced file, no manual setup per document
- **Graceful fallback** — if the WebSocket disconnects, edits are preserved locally and synced when reconnected

### Version History
- **Google Sheets-style history** — browse past versions of any document in the History sidebar tab
- **Session grouping** — edits grouped by editing session, showing who made changes and when
- **One-click restore** — preview any version and restore it with a single click
- **Shared across team** — history stored in S3, visible to all team members
- **Automatic capture** — snapshots saved on typing pauses (5s) during collaboration and on every sync push

### Sync & Conflict Resolution
- **Bidirectional S3 sync** — automatic pull/push with configurable intervals
- **Conflict resolution** — side-by-side diff modal, or auto-resolve with prefer-local/prefer-remote
- **Offline queue** — changes queued when offline and synced when back online
- **Activity log** — full history of sync events grouped by day

### Team Features
- **Team presence** — see who's online, what they're editing, and their status
- **Status updates** — set a short status message visible to your team
- **Group chat** — lightweight team chat with @user and !file mentions and autocomplete
- **Hand-offs** — structured work hand-offs with context, decisions, blockers, and next steps

## Quick Start

### 1. Create an S3 Bucket

```bash
BUCKET_NAME="my-team-knowledge-base"
AWS_REGION="eu-central-1"

aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

### 2. Create IAM Credentials

Create `kb-sync-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:HeadBucket"],
      "Resource": [
        "arn:aws:s3:::my-team-knowledge-base",
        "arn:aws:s3:::my-team-knowledge-base/*"
      ]
    }
  ]
}
```

```bash
aws iam create-policy --policy-name KBSyncPolicy --policy-document file://kb-sync-policy.json
aws iam create-user --user-name kb-sync-user
aws iam attach-user-policy --user-name kb-sync-user --policy-arn "arn:aws:iam::YOUR_ACCOUNT_ID:policy/KBSyncPolicy"
aws iam create-access-key --user-name kb-sync-user
```

### 3. Deploy Live Collaboration (Optional)

Deploy the serverless WebSocket infrastructure for real-time co-editing:

```bash
aws cloudformation deploy \
  --template-file infra/collab-stack.yaml \
  --stack-name kb-collab \
  --capabilities CAPABILITY_IAM \
  --region "$AWS_REGION"
```

Get the WebSocket URL:

```bash
aws cloudformation describe-stacks --stack-name kb-collab \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" \
  --output text --region "$AWS_REGION"
```

**Cost**: ~$0.10/day during active co-editing. Scales to zero when idle. Uses API Gateway WebSocket + Lambda (ARM64) + DynamoDB on-demand.

### 4. Install the Plugin

**Via BRAT** (recommended):
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from community plugins
2. Add beta plugin: `Saiki77/surfacer-kb-obsidian`

**Manual**: Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/Saiki77/surfacer-kb-obsidian/releases/latest) into `<vault>/.obsidian/plugins/kb-s3-sync/`

### 5. Configure

In Settings > Knowledge Base S3 Sync:

| Setting | Description |
|---------|-------------|
| **S3 Bucket** | Your bucket name |
| **S3 Prefix** | Object key prefix (default: `knowledge-base/`) |
| **AWS Region** | Bucket region |
| **Credential Mode** | `AWS Profile` or `Access Key / Secret Key` |
| **Sync Folder** | Local vault folder to sync (default: `knowledge-base`) |
| **Pull/Push Interval** | Sync frequency (default: 2 min pull, 10 min push) |
| **Your Name** | Display name for presence, chat, and collaboration |
| **Enable Live Collaboration** | Toggle real-time co-editing |
| **WebSocket URL** | The `wss://` URL from the CloudFormation output |

## Architecture

```
Obsidian Vault ←→ S3 Bucket (source of truth)
                     ├── knowledge-base/     # Synced documents
                     ├── _presence/          # Team presence
                     ├── _chat/              # Team chat
                     ├── _handoffs/          # Work hand-offs
                     ├── _history/           # Version snapshots
                     └── _collab/            # Yjs CRDT state

Live Editing: Obsidian ←→ API Gateway WebSocket ←→ Lambda ←→ DynamoDB
```

- **S3** is the persistent source of truth for documents and collaboration data
- **API Gateway WebSocket** provides real-time message routing between peers
- **Lambda** (ARM64, 128MB) handles connect/disconnect/broadcast with ~50ms execution time
- **DynamoDB** (on-demand) tracks active WebSocket connections per document
- **Yjs CRDT** ensures conflict-free merging regardless of message ordering

## Sidebar Tabs

| Tab | Description |
|-----|-------------|
| **Files** | Browse synced files in a tree view |
| **Team** | See who's online, what they're editing |
| **Chat** | Team chat with @user and !file mentions |
| **Handoffs** | View/claim/complete work hand-offs |
| **Activity** | Sync event log grouped by day |
| **History** | Version history for the active document |

## Team Onboarding

1. Share S3 bucket name, region, and credentials
2. Share the WebSocket URL (if using live collaboration)
3. Install plugin via BRAT: `Saiki77/surfacer-kb-obsidian`
4. Configure settings and set their name
5. First pull loads all existing documents

## Security

- No credentials in source code — stored locally in Obsidian plugin data
- IAM policy grants minimum required S3 permissions
- Consider enabling S3 bucket encryption (SSE-S3 or SSE-KMS)
- Chat and presence data stored as plain JSON in S3

## Development

```bash
git clone https://github.com/Saiki77/surfacer-kb-obsidian.git
cd surfacer-kb-obsidian
npm install
npm run build
npm run dev  # Watch mode
```

## License

[CC BY-NC 4.0](LICENSE)
