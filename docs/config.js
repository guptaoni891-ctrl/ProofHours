const REC = "tuple(uint256 id, uint256 eventId, bytes32 volunteerCommitment, uint16 hoursLogged, address issuer, uint64 recordedAt, uint64 recordedBlock, uint8 entryType, uint256 replacesRecordId, uint256 supersededBy, bytes32 reasonCode)";

window.CONFIG = {
  // TODO after Base Sepolia deploy: replace with the real address (this one is the local anvil deploy)
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  chainId: 84532,
  chainIdHex: "0x14a34",
  // Read-only RPCs, tried in order. `?rpc=<url>` overrides (local anvil fork backup).
  rpcs: [
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
    "https://sepolia.base.org",
  ],
  explorers: [
    { name: "BaseScan", url: "https://sepolia.basescan.org" },
    { name: "Blockscout", url: "https://base-sepolia.blockscout.com" },
  ],
  // Registered by script/Seed.s.sol; no known key, used only for the "non-issuer correction" staticCall.
  secondCoordinator: "0x000000000000000000000000000000000000dEaD",
  demoEventId: 1,
  abi: [
    "error UnauthorizedAdmin(address caller)",
    "error UnauthorizedCoordinator(address caller)",
    "error InvalidAddress()",
    "error InvalidDuration(uint16 maxDurationHours)",
    "error EventNotFound(uint256 eventId)",
    "error NotEventOwner(uint256 eventId, address caller, address owner)",
    "error EmptyCommitment()",
    "error InvalidHours(uint16 hoursLogged, uint16 maxDurationHours)",
    "error DuplicateVolunteerRecord(uint256 eventId, bytes32 volunteerCommitment)",
    "error RecordNotFound(uint256 recordId)",
    "error NotOriginalIssuer(uint256 recordId, address caller, address originalIssuer)",
    "error RecordAlreadySuperseded(uint256 recordId, uint256 supersededBy)",
    "error RecordIsRevoked(uint256 recordId)",
    "event HoursRecorded(uint256 indexed recordId, uint256 indexed eventId, bytes32 indexed volunteerCommitment, uint16 hoursLogged)",
    "event CorrectionAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, uint16 newHours, bytes32 reasonCode)",
    "event RevocationAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, bytes32 reasonCode)",
    "event EventCreated(uint256 indexed eventId, address indexed coordinator, string eventCode, uint16 maxDurationHours)",
    "function admin() view returns (address)",
    "function coordinators(address) view returns (bool active, string orgLabel)",
    "function events(uint256) view returns (address coordinator, uint16 maxDurationHours, string eventCode)",
    "function eventCount() view returns (uint256)",
    "function recordCount() view returns (uint256)",
    "function registerCoordinator(address coordinator, string orgLabel)",
    "function revokeCoordinator(address coordinator)",
    "function createEvent(string eventCode, uint16 maxDurationHours) returns (uint256)",
    "function recordVolunteerHours(uint256 eventId, bytes32 volunteerCommitment, uint16 hoursLogged) returns (uint256)",
    "function appendCorrection(uint256 recordId, uint16 newHours, bytes32 reasonCode) returns (uint256)",
    "function appendRevocation(uint256 recordId, bytes32 reasonCode) returns (uint256)",
    `function getRecord(uint256 recordId) view returns (${REC})`,
    `function getEffectiveRecord(uint256 recordId) view returns (${REC} head, uint256[] trailIds)`,
    "function getRecordsByCommitment(bytes32 commitment, uint256 offset, uint256 limit) view returns (uint256[] ids, uint256 total)",
  ],
};
