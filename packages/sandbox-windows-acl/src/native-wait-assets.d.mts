export interface WaitAssetManifest {
  protocol: number; platform: string; arch: string; koffiVersion: string; export: string;
  files: Record<string, string>; abi: { return: string; arguments: string[]; convention: string };
  build: { compiler: string; sdk: string };
}
export function verifyWaitAssets(root: string): { manifest: WaitAssetManifest; workerPath: string; bridgePath: string }
