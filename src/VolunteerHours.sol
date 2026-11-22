// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VolunteerHours: append-only, NGO-signed volunteer-hour records (Base Sepolia demo).
/// @notice Only salted commitments of fake student IDs are stored. Nothing is ever edited or deleted:
///         corrections and revocations are new records that point back at the one they replace.
contract VolunteerHours {
    // ---------- Errors ----------
    error UnauthorizedAdmin(address caller);
    error UnauthorizedCoordinator(address caller); // not registered, or revoked
    error InvalidAddress();
    error InvalidDuration(uint16 maxDurationHours); // must be 1..24
    error EventNotFound(uint256 eventId);
    error NotEventOwner(uint256 eventId, address caller, address owner);
    error EmptyCommitment();
    error InvalidHours(uint16 hoursLogged, uint16 maxDurationHours); // 0 or > max
    error DuplicateVolunteerRecord(uint256 eventId, bytes32 volunteerCommitment);
    error RecordNotFound(uint256 recordId);
    error NotOriginalIssuer(uint256 recordId, address caller, address originalIssuer);
    error RecordAlreadySuperseded(uint256 recordId, uint256 supersededBy);
    error RecordIsRevoked(uint256 recordId);

    // ---------- Types ----------
    enum EntryType { ORIGINAL, CORRECTION, REVOCATION }

    struct Coordinator { bool active; string orgLabel; }
    struct VolunteerEvent { address coordinator; uint16 maxDurationHours; string eventCode; }
    struct VolunteerRecord {
        uint256 id;
        uint256 eventId;
        bytes32 volunteerCommitment; // keccak256(abi.encodePacked(bytes32 salt, string fakeId))
        uint16 hoursLogged;          // 0 for REVOCATION
        address issuer;
        uint64 recordedAt;           // block.timestamp (informational only)
        uint64 recordedBlock;        // block.number (for the single-block tx lookup)
        EntryType entryType;
        uint256 replacesRecordId;    // 0 if ORIGINAL
        uint256 supersededBy;        // 0 if current head
        bytes32 reasonCode;          // e.g. "TYPO_FIX", "ATTENDANCE_VOID"
    }

    // ---------- Events ----------
    event CoordinatorRegistered(address indexed coordinator, string orgLabel);
    event CoordinatorRevoked(address indexed coordinator);
    event EventCreated(uint256 indexed eventId, address indexed coordinator, string eventCode, uint16 maxDurationHours);
    event HoursRecorded(uint256 indexed recordId, uint256 indexed eventId, bytes32 indexed volunteerCommitment, uint16 hoursLogged);
    event CorrectionAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, uint16 newHours, bytes32 reasonCode);
    event RevocationAppended(uint256 indexed newRecordId, uint256 indexed replacesRecordId, bytes32 reasonCode);

    // ---------- State ----------
    uint256 public constant MAX_TRAIL = 25;

    address public admin;
    mapping(address => Coordinator) public coordinators;

    mapping(uint256 => VolunteerEvent) public events; // ids start at 1
    uint256 public eventCount;

    mapping(uint256 => VolunteerRecord) private records; // ids start at 1; read via getRecord
    uint256 public recordCount;

    mapping(uint256 => mapping(bytes32 => bool)) public hasRecorded; // eventId => commitment => recorded
    mapping(bytes32 => uint256[]) private originalsByCommitment;     // ORIGINAL record ids only

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert UnauthorizedAdmin(msg.sender);
        _;
    }

    modifier onlyActiveCoordinator() {
        if (!coordinators[msg.sender].active) revert UnauthorizedCoordinator(msg.sender);
        _;
    }

    // ---------- Admin (R1) ----------
    function registerCoordinator(address coordinator, string calldata orgLabel) external onlyAdmin {
        if (coordinator == address(0)) revert InvalidAddress();
        coordinators[coordinator] = Coordinator(true, orgLabel);
        emit CoordinatorRegistered(coordinator, orgLabel);
    }

    function revokeCoordinator(address coordinator) external onlyAdmin {
        if (coordinator == address(0)) revert InvalidAddress();
        coordinators[coordinator].active = false; // label kept so old records still show who signed them
        emit CoordinatorRevoked(coordinator);
    }

    // ---------- Coordinator ----------
    function createEvent(string calldata eventCode, uint16 maxDurationHours)
        external
        onlyActiveCoordinator
        returns (uint256 eventId)
    {
        if (maxDurationHours == 0 || maxDurationHours > 24) revert InvalidDuration(maxDurationHours);
        eventId = ++eventCount;
        events[eventId] = VolunteerEvent(msg.sender, maxDurationHours, eventCode);
        emit EventCreated(eventId, msg.sender, eventCode, maxDurationHours);
    }

    /// R2 (event owner), R3 (one per event+volunteer), R4 (1..max hours)
    function recordVolunteerHours(uint256 eventId, bytes32 volunteerCommitment, uint16 hoursLogged)
        external
        onlyActiveCoordinator
        returns (uint256 recordId)
    {
        VolunteerEvent storage ev = _event(eventId);
        if (ev.coordinator != msg.sender) revert NotEventOwner(eventId, msg.sender, ev.coordinator);
        if (volunteerCommitment == bytes32(0)) revert EmptyCommitment();
        _checkHours(hoursLogged, ev.maxDurationHours);
        if (hasRecorded[eventId][volunteerCommitment]) revert DuplicateVolunteerRecord(eventId, volunteerCommitment);

        hasRecorded[eventId][volunteerCommitment] = true;
        recordId = _append(eventId, volunteerCommitment, hoursLogged, EntryType.ORIGINAL, 0, bytes32(0));
        originalsByCommitment[volunteerCommitment].push(recordId);
        emit HoursRecorded(recordId, eventId, volunteerCommitment, hoursLogged);
    }

    /// R4 + R5. The old record keeps its hours; only its supersededBy pointer is set.
    function appendCorrection(uint256 recordId, uint16 newHours, bytes32 reasonCode)
        external
        onlyActiveCoordinator
        returns (uint256 newId)
    {
        VolunteerRecord storage old = _headOwnedBySender(recordId);
        _checkHours(newHours, events[old.eventId].maxDurationHours);
        newId = _append(old.eventId, old.volunteerCommitment, newHours, EntryType.CORRECTION, recordId, reasonCode);
        old.supersededBy = newId;
        emit CorrectionAppended(newId, recordId, newHours, reasonCode);
    }

    /// R5. A revocation is a terminal head with 0 hours.
    function appendRevocation(uint256 recordId, bytes32 reasonCode)
        external
        onlyActiveCoordinator
        returns (uint256 newId)
    {
        VolunteerRecord storage old = _headOwnedBySender(recordId);
        newId = _append(old.eventId, old.volunteerCommitment, 0, EntryType.REVOCATION, recordId, reasonCode);
        old.supersededBy = newId;
        emit RevocationAppended(newId, recordId, reasonCode);
    }

    // ---------- Public reads ----------
    function getRecord(uint256 recordId) external view returns (VolunteerRecord memory) {
        return _record(recordId);
    }

    /// Walks supersededBy from recordId to the current head. trailIds[0] = recordId, last = head.
    /// shortcut: stops after MAX_TRAIL entries; if head.supersededBy != 0 the caller should call again from head.id.
    function getEffectiveRecord(uint256 recordId)
        external
        view
        returns (VolunteerRecord memory head, uint256[] memory trailIds)
    {
        _record(recordId);
        uint256 n = 1;
        uint256 id = recordId;
        while (records[id].supersededBy != 0 && n < MAX_TRAIL) {
            id = records[id].supersededBy;
            n++;
        }
        trailIds = new uint256[](n);
        id = recordId;
        for (uint256 i; i < n; i++) {
            trailIds[i] = id;
            id = records[id].supersededBy;
        }
        head = records[trailIds[n - 1]];
    }

    /// ORIGINAL record ids for a commitment, paginated.
    function getRecordsByCommitment(bytes32 commitment, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        uint256[] storage all = originalsByCommitment[commitment];
        total = all.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 end = offset + limit > total ? total : offset + limit;
        ids = new uint256[](end - offset);
        for (uint256 i; i < ids.length; i++) ids[i] = all[offset + i];
    }

    // ---------- Internals ----------
    function _event(uint256 eventId) private view returns (VolunteerEvent storage ev) {
        if (eventId == 0 || eventId > eventCount) revert EventNotFound(eventId);
        ev = events[eventId];
    }

    function _record(uint256 recordId) private view returns (VolunteerRecord storage r) {
        if (recordId == 0 || recordId > recordCount) revert RecordNotFound(recordId);
        r = records[recordId];
    }

    function _checkHours(uint16 h, uint16 max) private pure {
        if (h == 0 || h > max) revert InvalidHours(h, max);
    }

    /// R5: only the original issuer, only the current head, never a revocation.
    function _headOwnedBySender(uint256 recordId) private view returns (VolunteerRecord storage r) {
        r = _record(recordId);
        if (r.issuer != msg.sender) revert NotOriginalIssuer(recordId, msg.sender, r.issuer);
        if (r.entryType == EntryType.REVOCATION) revert RecordIsRevoked(recordId);
        if (r.supersededBy != 0) revert RecordAlreadySuperseded(recordId, r.supersededBy);
    }

    function _append(
        uint256 eventId,
        bytes32 commitment,
        uint16 hoursLogged,
        EntryType entryType,
        uint256 replaces,
        bytes32 reasonCode
    ) private returns (uint256 id) {
        id = ++recordCount;
        records[id] = VolunteerRecord({
            id: id,
            eventId: eventId,
            volunteerCommitment: commitment,
            hoursLogged: hoursLogged,
            issuer: msg.sender,
            recordedAt: uint64(block.timestamp),
            recordedBlock: uint64(block.number),
            entryType: entryType,
            replacesRecordId: replaces,
            supersededBy: 0,
            reasonCode: reasonCode
        });
    }
}
