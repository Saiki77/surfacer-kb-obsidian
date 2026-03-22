# Knowledge Base S3 Sync for Obsidian

Bidirectional sync between your Obsidian vault and an S3-backed knowledge base. Built for small teams that want real-time collaboration features — live presence, team chat, hand-offs, and conflict resolution — all powered by a single S3 bucket.

## Features

- **Bidirectional S3 sync** — automatic pull/push with configurable intervals
- **Conflict resolution** — side-by-side diff modal, or auto-resolve with prefer-local/prefer-remote
- **Team presence** — see who's online, what they're editing, and their status
- **Status updates** — set a short status message visible to your team
- **Offline indicators** — team members shown as active, away, or offline
- **Group chat** — lightweight team chat stored in S3
- **Hand-offs** — structured work hand-offs with context, decisions, blockers, and next steps
- **Offline queue** — changes are queued when offline and synced when back
- **Activity log** — full history of sync events grouped by day

## AWS Setup

The plugin needs an S3 bucket and IAM credentials. Here's how to set it up.

### 1. Create an S3 Bucket

```bash
# Pick a globally unique bucket name
BUCKET_NAME="my-team-knowledge-base"
AWS_REGION="us-east-1"

aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$AWS_REGION"
```

If your region is **not** `us-east-1`, add the location constraint:

```bash
aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

### 2. Enable Versioning (Recommended)

Versioning protects against accidental overwrites and deletions:

```bash
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled
```

### 3. Create an IAM Policy

Create a file called `kb-sync-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KBSyncAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:HeadBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-team-knowledge-base",
        "arn:aws:s3:::my-team-knowledge-base/*"
      ]
    }
  ]
}
```

Replace `my-team-knowledge-base` with your bucket name, then create the policy:

```bash
aws iam create-policy \
  --policy-name KBSyncPolicy \
  --policy-document file://kb-sync-policy.json
```

### 4. Create an IAM User (Option A: Access Keys)

Best for quick setup or when team members don't have AWS CLI configured.

```bash
aws iam create-user --user-name kb-sync-user

aws iam attach-user-policy \
  --user-name kb-sync-user \
  --policy-arn "arn:aws:iam::YOUR_ACCOUNT_ID:policy/KBSyncPolicy"

aws iam create-access-key --user-name kb-sync-user
```

Save the `AccessKeyId` and `SecretAccessKey` from the output. Each team member can use the same credentials, or create separate users per person for audit trails.

### 4. Use an AWS Profile (Option B: AWS CLI)

If team members already have the AWS CLI configured:

```bash
# Each team member adds a profile to ~/.aws/credentials
[kb-sync]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

Then select "AWS Profile" in the plugin settings and enter `kb-sync`.

### 5. S3 Bucket Structure

The plugin uses these prefixes in your bucket:

```
s3://your-bucket/
├── knowledge-base/        # Your synced documents (configurable prefix)
│   ├── architecture/
│   ├── decisions/
│   └── ...
├── _presence/             # Team presence data (auto-managed)
│   └── {username}.json
├── _chat/                 # Team chat messages (auto-managed)
│   └── {message-id}.json
└── _handoffs/             # Work hand-offs (auto-managed)
    └── {handoff-id}.json
```

Prefixes starting with `_` are managed by the plugin and excluded from file sync.

## Installation

### Via BRAT (Recommended for Teams)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from Obsidian's community plugins
2. Open BRAT settings, click **Add Beta plugin**
3. Enter: `Saiki77/surfacer-kb-obsidian`
4. Enable the plugin in Settings > Community Plugins

BRAT will notify you when updates are available.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Saiki77/surfacer-kb-obsidian/releases/latest)
2. Create a folder: `<your-vault>/.obsidian/plugins/kb-s3-sync/`
3. Copy the three files into that folder
4. Enable the plugin in Settings > Community Plugins

## Plugin Configuration

After installation, open Settings > Knowledge Base S3 Sync:

| Setting | Description |
|---------|-------------|
| **S3 Bucket** | Your bucket name |
| **S3 Prefix** | Object key prefix (default: `knowledge-base/`) |
| **AWS Region** | Bucket region (e.g., `us-east-1`) |
| **Credential Mode** | `AWS Profile` or `Access Key / Secret Key` |
| **Sync Folder** | Local vault folder to sync (default: `knowledge-base`) |
| **Pull Interval** | How often to check for remote changes (default: 2 min) |
| **Push Interval** | How often to upload local changes (default: 10 min) |
| **Conflict Strategy** | `Ask me` (diff modal), `Prefer local`, or `Prefer remote` |
| **Your Name** | Display name for presence and chat |

## Team Onboarding

To add a new team member:

1. Share the S3 bucket name, region, and credentials (or IAM setup instructions)
2. Have them install the plugin via BRAT: `Saiki77/surfacer-kb-obsidian`
3. Configure the plugin settings with the shared bucket details
4. Set their name in the Collaboration section

They'll immediately see existing documents after the first pull, and appear in the Team tab for others.

## Security Notes

- **No credentials are stored in the plugin source code.** All AWS credentials are entered by each user in their local plugin settings and stored in Obsidian's plugin data (`.obsidian/plugins/kb-s3-sync/data.json`).
- Use the principle of least privilege — the IAM policy above only grants the minimum S3 permissions needed.
- Consider enabling S3 bucket encryption (SSE-S3 or SSE-KMS) for data at rest.
- Consider enabling S3 access logging for audit trails.
- The `_chat/` and `_presence/` data is stored as plain JSON in S3 — don't share sensitive information in chat if your bucket access is broad.

## Development

```bash
git clone https://github.com/Saiki77/surfacer-kb-obsidian.git
cd surfacer-kb-obsidian
npm install
npm run build              # Development build (with source maps)
npm run build -- --production  # Production build (minified)
```

For live development, symlink into your vault:

```bash
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/kb-s3-sync"
npm run build -- --watch
```

## License

[CC BY-NC 4.0](LICENSE)
