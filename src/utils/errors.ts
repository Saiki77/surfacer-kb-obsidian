export function formatAwsError(error: unknown, operation: string): string {
  if (error instanceof Error) {
    const name = (error as any).name || error.constructor.name;
    switch (name) {
      case "CredentialsProviderError":
      case "ExpiredTokenException":
        return `AWS credentials error: ${error.message}. Check your credentials configuration.`;
      case "NoSuchKey":
        return `Document not found in the knowledge base.`;
      case "NoSuchBucket":
        return `S3 bucket not found. Check your bucket configuration.`;
      case "AccessDeniedException":
        return `Access denied for ${operation}. Check your IAM permissions.`;
      default:
        return `Error during ${operation}: ${error.message}`;
    }
  }
  return `Unknown error during ${operation}: ${String(error)}`;
}
