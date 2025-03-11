/**
 * Configuration for allocators used in signature verification
 */
export const ALLOCATORS = {
  AUTOCATOR: {
    id: "1730150456036417775412616585",
    signingAddress: "0x4491fB95F2d51416688D4862f0cAeFE5281Fa3d9", // used to verify signatures from server
    url: "https://autocator.org",
  },
  SMALLOCATOR: {
    id: "1223867955028248789127899354",
    signingAddress: "0x51044301738Ba2a27bd9332510565eBE9F03546b",
    url: "https://smallocator.xyz",
  },
} as const;
