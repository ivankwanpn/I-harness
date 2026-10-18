/** Region chain: config.region → AWS_REGION → AWS_DEFAULT_REGION → us-east-1. */
export function resolveBedrockRegion(
  region: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1"
}
