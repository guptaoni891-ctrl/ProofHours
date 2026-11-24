const REC = "tuple(uint256 id, uint256 eventId, bytes32 volunteerCommitment, uint16 hoursLogged, address issuer, uint64 recordedAt, uint64 recordedBlock, uint8 entryType, uint256 replacesRecordId, uint256 supersededBy, bytes32 reasonCode)";

window.CONFIG = {
  // Base Sepolia deploy (Remix, 2026-11-24): tx 0x4464f73e25108e65c6465b5b518d54a386f237ee685200eac51754002483de88, block 62946611
  address: "0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b",
  chainId: 84532,
  chainIdHex: "0x14a34",
  netName: "Base Sepolia",
  // Read-only RPCs, tried in order. `?rpc=<url>` overrides (local anvil fork backup).
  rpcs: [
    "https://base-sepolia-rpc.publicnode.com",
    "https://sepolia.base.org",
    "https://base-sepolia.drpc.org", // last: the free tier often times out (408)
  ],
  explorers: [
    { name: "BaseScan", url: "https://sepolia.basescan.org" },
    { name: "Blockscout", url: "https://base-sepolia.blockscout.com" },
  ],
  // Registered by script/Seed.s.sol; no known key, used only for the "non-issuer correction" staticCall.
  secondCoordinator: "0x000000000000000000000000000000000000dEaD",
  demoEventId: 1,
  // Used with `?local` or a localhost `?rpc=`: a private local FORK of Base Sepolia, for safe write tests.
  // Its own chain id means MetaMask can never mix it up with Base Sepolia. Nothing written there reaches the public chain.
  // Start it with: anvil --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 31337 --port 8546
  local: {
    netName: "Anvil Local (fork)",
    chainId: 31337,
    chainIdHex: "0x7a69",
    rpcs: ["http://127.0.0.1:8546"],
    address: "0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b", // same contract and records as Base Sepolia, copied into the fork
    explorers: [],
  },
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
    "event CoordinatorRegistered(address indexed coordinator, string orgLabel)",
    "event CoordinatorRevoked(address indexed coordinator)",
    "event HoursRecorded(uint256 indexed recordId, uint256 indexed eventId, bytes32 indexed volunteerCommitment, uint16 hoursLogged)",
    "event CorrectionAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, uint16 newHours, bytes32 reasonCode)",
    "event RevocationAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, bytes32 reasonCode)",
    "event EventCreated(uint256 indexed eventId, address indexed coordinator, string eventCode, uint16 maxDurationHours)",
    "function admin() view returns (address)",
    "function coordinators(address) view returns (bool active, string orgLabel)",
    "function events(uint256) view returns (address coordinator, uint16 maxDurationHours, string eventCode)",
    "function eventCount() view returns (uint256)",
    "function recordCount() view returns (uint256)",
    "function hasRecorded(uint256 eventId, bytes32 volunteerCommitment) view returns (bool)",
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
