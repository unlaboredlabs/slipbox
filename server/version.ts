// Replaced at build time by server/build.ts for release builds.
// A release's version is one integer: the number of commits on main.
export const VERSION: string = "dev";
export const COMMIT: string = "";
export const BUILD_DATE: string = "";

export function versionLine(name: string): string {
  if (VERSION === "dev") return `${name} dev`;
  return `${name} ${VERSION} (${COMMIT}, ${BUILD_DATE})`;
}
