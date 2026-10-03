declare module "picomatch" {
  export default function picomatch(pattern: string | readonly string[], options?: { dot?: boolean; basename?: boolean }): (path: string) => boolean
}
