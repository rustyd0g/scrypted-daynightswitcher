export type MixinMembership = {
  mixins?: readonly string[];
};

export function isMixinProviderApplied(
  providerId: string,
  device: MixinMembership | null | undefined,
): boolean {
  return device?.mixins?.includes(providerId) === true;
}
