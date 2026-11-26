declare module "snarkjs" {
  export const groth16: unknown;
}

declare module "leveldown" {
  const LevelDOWN: new (location: string) => ConstructorParameters<
    typeof import("@railgun-community/engine").Database
  >[0];
  export default LevelDOWN;
}
