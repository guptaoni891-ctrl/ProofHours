// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ProofHoursBadges} from "./ProofHoursBadges.sol";

/// Read-only view of the V1 VolunteerHours contract (0xFbDC…9F9b on Base Sepolia). V1 is never written to.
interface IVolunteerHoursV1 {
    struct V1Record {
        uint256 id;
        uint256 eventId;
        bytes32 volunteerCommitment;
        uint16 hoursLogged;
        address issuer;
        uint64 recordedAt;
        uint64 recordedBlock;
        uint8 entryType; // 0 ORIGINAL, 1 CORRECTION, 2 REVOCATION
        uint256 replacesRecordId;
        uint256 supersededBy;
        bytes32 reasonCode;
    }

    function getRecord(uint256 recordId) external view returns (V1Record memory);
    function getEffectiveRecord(uint256 recordId) external view returns (V1Record memory head, uint256[] memory trailIds);
}

/// @title ProofHours V2 ledger: wallet-linked, categorised, cumulative volunteer hours.
/// @notice Permissions (see docs/V2_SECURITY_MODEL.md):
///  - Governance (DEFAULT_ADMIN_ROLE, intended to be a multisig) registers NGOs and their admins, sets caps,
///    reinstates suspended NGOs, unpauses, and can revoke records after a dispute.
///  - AUDITOR_ROLE can suspend an NGO and pause issuance (fast containment), never issue or reinstate.
///  - An NGO admin assigns coordinator wallets for its own NGO only. Coordinators hold no AccessControl
///    role, so they cannot grant themselves admin, auditor or governance powers.
///  - Coordinators issue, correct and revoke hours only for their own NGO's events.
///  - Volunteers opt in before receiving hours (consent; also the ERC-5484 consent for badges).
///  Totals only ever come from NGO-issued records or NGO-approved V1 imports; there is no self-reported path.
contract ProofHoursLedger is AccessControl, Pausable {
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint16 public constant DAILY_CAP = 12; // anti-hour-farming cap per volunteer per service day
    uint16 public constant EMERGENCY_DAILY_CAP = 24; // emergency-response override
    uint8 public constant CATEGORY_COUNT = 5;
    bytes32 public constant V1_SYNC_REASON = "V1_SYNC";

    enum Category {
        Environmental,
        Education,
        Healthcare,
        Emergency,
        Inclusion
    }
    enum EntryType {
        Original,
        Correction,
        Revocation,
        MigratedV1
    }

    struct Org {
        string name;
        address admin;
        bool suspended;
        uint32 dailyIssueCap; // circuit breaker: max hours this NGO can issue per day
    }

    struct Event {
        uint256 orgId;
        Category category;
        uint16 maxHours;
        uint32 serviceDay; // days since Unix epoch (UTC) when the service happens
        address createdBy;
        string code;
    }

    struct Record {
        uint256 id;
        uint256 eventId; // 0 for V1 imports
        address volunteer;
        uint16 hoursLogged;
        EntryType entryType;
        Category category;
        uint256 orgId;
        address issuer;
        uint64 recordedAt;
        uint32 serviceDay; // 0 for V1 imports (historical, exempt from the daily cap)
        uint256 replacesId;
        uint256 supersededBy;
        bytes32 evidenceHash; // hash of off-chain evidence (attendance log etc.), never personal data
        bytes32 reason;
        uint256 v1RecordId; // V1 original record id for imports and their syncs
    }

    ProofHoursBadges public immutable badges;
    IVolunteerHoursV1 public immutable v1;

    uint256 public orgCount;
    uint256 public eventCount;
    uint256 public recordCount;
    mapping(uint256 => Org) internal _orgs;
    mapping(uint256 => Event) internal _events;
    mapping(uint256 => Record) internal _records;
    mapping(address coordinator => uint256 orgId) public coordinatorOrg;
    mapping(address => bool) public optedIn;
    mapping(uint256 eventId => mapping(address volunteer => bool)) public hasRecord;
    mapping(address => uint256) public totalHours;
    mapping(address => uint256[5]) internal _categoryHours;
    mapping(address => mapping(uint32 day => uint256)) public dayHours;
    mapping(uint256 orgId => mapping(uint32 day => uint256)) public orgDayIssued;
    mapping(address => uint256[]) internal _originals;
    mapping(uint256 v1Id => address volunteer) public v1LinkRequest;
    mapping(uint256 v1Id => uint256 v2RecordId) public v1Migrated;

    error NotOrgAdmin(uint256 orgId, address caller);
    error NotCoordinator(address caller);
    error OrgNotFound(uint256 orgId);
    error OrgIsSuspended(uint256 orgId);
    error CoordinatorOfOtherOrg(address coordinator, uint256 orgId);
    error InvalidAddress();
    error InvalidHours(uint16 hoursLogged, uint16 maxHours);
    error InvalidDuration(uint16 maxHours);
    error EventNotFound(uint256 eventId);
    error WrongOrg(uint256 expected, uint256 caller);
    error NotOptedIn(address volunteer);
    error DuplicateRecord(uint256 eventId, address volunteer);
    error ServiceDayInFuture(uint32 serviceDay, uint32 today);
    error DailyCapExceeded(address volunteer, uint32 day, uint256 wouldBe, uint16 cap);
    error OrgDailyCapExceeded(uint256 orgId, uint256 wouldBe, uint32 cap);
    error RecordNotFound(uint256 recordId);
    error RecordAlreadySuperseded(uint256 recordId, uint256 supersededBy);
    error RecordIsRevoked(uint256 recordId);
    error UseV1Sync(uint256 recordId);
    error LengthMismatch();
    error NoLinkRequest(uint256 v1Id);
    error AlreadyMigrated(uint256 v1Id, uint256 v2RecordId);
    error NotV1Original(uint256 v1Id);
    error NotV1Issuer(uint256 v1Id, address caller, address issuer);
    error NotMigrated(uint256 v1Id);
    error NothingToSync(uint256 v1Id);
    error V1NotConfigured();

    event OrgRegistered(uint256 indexed orgId, string name, address indexed admin, uint32 dailyIssueCap);
    event OrgAdminChanged(uint256 indexed orgId, address indexed admin);
    event OrgDailyCapChanged(uint256 indexed orgId, uint32 dailyIssueCap);
    event OrgSuspended(uint256 indexed orgId, address indexed by);
    event OrgReinstated(uint256 indexed orgId, address indexed by);
    event CoordinatorSet(address indexed coordinator, uint256 indexed orgId, address indexed by);
    event CoordinatorRemoved(address indexed coordinator, uint256 indexed orgId, address indexed by);
    event VolunteerOptedIn(address indexed volunteer);
    event VolunteerOptedOut(address indexed volunteer);
    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, Category category, uint16 maxHours, uint32 serviceDay, string code);
    event HoursIssued(uint256 indexed recordId, uint256 indexed eventId, address indexed volunteer, uint16 hoursLogged, Category category, bytes32 evidenceHash);
    event RecordCorrected(uint256 indexed newRecordId, uint256 indexed replacesId, address indexed volunteer, uint16 newHours, bytes32 reason);
    event RecordRevoked(uint256 indexed newRecordId, uint256 indexed replacesId, address indexed volunteer, bytes32 reason);
    event V1LinkRequested(uint256 indexed v1Id, address indexed volunteer);
    event V1Migrated(uint256 indexed v1Id, uint256 indexed recordId, address indexed volunteer, uint16 hoursLogged, Category category);
    event TotalsChanged(address indexed volunteer, uint256 totalHours, Category category, uint256 categoryHours);

    constructor(address governance, ProofHoursBadges badges_, address v1_) {
        if (governance == address(0) || address(badges_) == address(0)) revert InvalidAddress();
        badges = badges_;
        v1 = IVolunteerHoursV1(v1_); // may be zero where no V1 exists (e.g. a fresh test chain)
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _grantRole(PAUSER_ROLE, governance);
    }

    // ---------- Governance ----------

    function registerOrg(string calldata name, address orgAdmin, uint32 dailyIssueCap) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 orgId) {
        if (orgAdmin == address(0)) revert InvalidAddress();
        orgId = ++orgCount;
        _orgs[orgId] = Org(name, orgAdmin, false, dailyIssueCap);
        emit OrgRegistered(orgId, name, orgAdmin, dailyIssueCap);
    }

    function setOrgAdmin(uint256 orgId, address orgAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _org(orgId);
        if (orgAdmin == address(0)) revert InvalidAddress();
        _orgs[orgId].admin = orgAdmin;
        emit OrgAdminChanged(orgId, orgAdmin);
    }

    function setOrgDailyCap(uint256 orgId, uint32 dailyIssueCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _org(orgId).dailyIssueCap = dailyIssueCap;
        emit OrgDailyCapChanged(orgId, dailyIssueCap);
    }

    /// Fast containment: an auditor (or governance) suspends an NGO; only governance reinstates it.
    function suspendOrg(uint256 orgId) external {
        if (!hasRole(AUDITOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, AUDITOR_ROLE);
        }
        _org(orgId).suspended = true;
        emit OrgSuspended(orgId, msg.sender);
    }

    function reinstateOrg(uint256 orgId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _org(orgId).suspended = false;
        emit OrgReinstated(orgId, msg.sender);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------- NGO admin ----------

    function setCoordinator(address coordinator, uint256 orgId) external {
        _requireOrgAdmin(orgId);
        if (coordinator == address(0)) revert InvalidAddress();
        uint256 current = coordinatorOrg[coordinator];
        // an NGO admin cannot take over another NGO's coordinator
        if (current != 0 && current != orgId && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert CoordinatorOfOtherOrg(coordinator, current);
        coordinatorOrg[coordinator] = orgId;
        emit CoordinatorSet(coordinator, orgId, msg.sender);
    }

    function removeCoordinator(address coordinator) external {
        uint256 orgId = coordinatorOrg[coordinator];
        if (orgId == 0) revert NotCoordinator(coordinator);
        _requireOrgAdmin(orgId);
        delete coordinatorOrg[coordinator];
        emit CoordinatorRemoved(coordinator, orgId, msg.sender);
    }

    // ---------- Volunteer consent ----------

    function optIn() external {
        optedIn[msg.sender] = true;
        emit VolunteerOptedIn(msg.sender);
    }

    /// Stops new issuance to this wallet. Existing records and badges stay (they are history).
    function optOut() external {
        optedIn[msg.sender] = false;
        emit VolunteerOptedOut(msg.sender);
    }

    // ---------- Coordinator: events and hours ----------

    function createEvent(string calldata code, Category category, uint16 maxHours, uint32 serviceDay) external whenNotPaused returns (uint256 eventId) {
        uint256 orgId = _activeCoordinatorOrg();
        if (maxHours == 0 || maxHours > 24) revert InvalidDuration(maxHours);
        eventId = ++eventCount;
        _events[eventId] = Event(orgId, category, maxHours, serviceDay, msg.sender, code);
        emit EventCreated(eventId, orgId, category, maxHours, serviceDay, code);
    }

    function issueHours(uint256 eventId, address volunteer, uint16 hoursLogged, bytes32 evidenceHash) external whenNotPaused returns (uint256) {
        return _issue(eventId, _activeCoordinatorOrg(), volunteer, hoursLogged, evidenceHash);
    }

    /// One transaction for a whole roster. All-or-nothing: any invalid line reverts the batch.
    function issueBatch(uint256 eventId, address[] calldata volunteers, uint16[] calldata hoursLogged, bytes32[] calldata evidence) external whenNotPaused returns (uint256 firstRecordId) {
        if (volunteers.length != hoursLogged.length || volunteers.length != evidence.length) revert LengthMismatch();
        uint256 orgId = _activeCoordinatorOrg();
        firstRecordId = recordCount + 1;
        for (uint256 i; i < volunteers.length; i++) _issue(eventId, orgId, volunteers[i], hoursLogged[i], evidence[i]);
    }

    function _issue(uint256 eventId, uint256 orgId, address volunteer, uint16 hoursLogged, bytes32 evidenceHash) internal returns (uint256 id) {
        Event storage ev = _event(eventId);
        if (ev.orgId != orgId) revert WrongOrg(ev.orgId, orgId);
        if (!optedIn[volunteer]) revert NotOptedIn(volunteer);
        if (hasRecord[eventId][volunteer]) revert DuplicateRecord(eventId, volunteer);
        if (hoursLogged == 0 || hoursLogged > ev.maxHours) revert InvalidHours(hoursLogged, ev.maxHours);
        uint32 today = uint32(block.timestamp / 1 days);
        if (ev.serviceDay > today) revert ServiceDayInFuture(ev.serviceDay, today);
        _chargeCaps(volunteer, ev.serviceDay, ev.category, orgId, hoursLogged);

        hasRecord[eventId][volunteer] = true;
        id = _append(Record(0, eventId, volunteer, hoursLogged, EntryType.Original, ev.category, orgId, msg.sender, uint64(block.timestamp), ev.serviceDay, 0, 0, evidenceHash, bytes32(0), 0));
        _originals[volunteer].push(id);
        emit HoursIssued(id, eventId, volunteer, hoursLogged, ev.category, evidenceHash);
        _adjust(volunteer, ev.category, 0, hoursLogged);
    }

    /// Appends a correction to the latest entry of a record. The old entry keeps its hours.
    function correct(uint256 recordId, uint16 newHours, bytes32 reason) external whenNotPaused returns (uint256 id) {
        Record storage head = _fixableHead(recordId);
        if (head.entryType == EntryType.MigratedV1 || head.v1RecordId != 0) revert UseV1Sync(recordId);
        if (_activeCoordinatorOrg() != head.orgId) revert WrongOrg(head.orgId, coordinatorOrg[msg.sender]);
        uint16 maxHours = _events[head.eventId].maxHours;
        if (newHours == 0 || newHours > maxHours) revert InvalidHours(newHours, maxHours);
        uint16 oldHours = head.hoursLogged;
        if (newHours > oldHours) _chargeCaps(head.volunteer, head.serviceDay, head.category, head.orgId, newHours - oldHours);
        else dayHours[head.volunteer][head.serviceDay] -= oldHours - newHours;
        id = _supersede(head, newHours, EntryType.Correction, reason, msg.sender);
        emit RecordCorrected(id, recordId, head.volunteer, newHours, reason);
        _adjust(head.volunteer, head.category, oldHours, newHours);
    }

    /// Revokes the latest entry (0 hours from now on). Same-NGO coordinators, or governance after a dispute.
    function revoke(uint256 recordId, bytes32 reason) external returns (uint256 id) {
        Record storage head = _fixableHead(recordId);
        bool governance = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!governance) {
            _requireNotPaused();
            if (head.v1RecordId != 0) revert UseV1Sync(recordId); // imported truth lives in V1; governance may still revoke
            if (_activeCoordinatorOrg() != head.orgId) revert WrongOrg(head.orgId, coordinatorOrg[msg.sender]);
        }
        uint16 oldHours = head.hoursLogged;
        if (head.serviceDay != 0) dayHours[head.volunteer][head.serviceDay] -= oldHours;
        id = _supersede(head, 0, EntryType.Revocation, reason, msg.sender);
        emit RecordRevoked(id, recordId, head.volunteer, reason);
        _adjust(head.volunteer, head.category, oldHours, 0);
    }

    // ---------- V1 migration (consent + issuing-NGO approval; hours are read from V1, never typed in) ----------

    /// Step 1, volunteer: "V1 record #v1Id is mine." Recorded as consent; grants nothing by itself.
    function requestV1Link(uint256 v1Id) external {
        if (address(v1) == address(0)) revert V1NotConfigured();
        if (!optedIn[msg.sender]) revert NotOptedIn(msg.sender);
        if (v1Migrated[v1Id] != 0) revert AlreadyMigrated(v1Id, v1Migrated[v1Id]);
        v1LinkRequest[v1Id] = msg.sender;
        emit V1LinkRequested(v1Id, msg.sender);
    }

    /// Step 2, the NGO wallet that originally issued the V1 record confirms (off-chain it checks the student's
    /// receipt). Imports the V1 record's current effective hours into the volunteer's V2 totals.
    function approveV1Link(uint256 v1Id, Category category) external whenNotPaused returns (uint256 id) {
        if (address(v1) == address(0)) revert V1NotConfigured();
        address volunteer = v1LinkRequest[v1Id];
        if (volunteer == address(0)) revert NoLinkRequest(v1Id);
        if (v1Migrated[v1Id] != 0) revert AlreadyMigrated(v1Id, v1Migrated[v1Id]);
        uint256 orgId = _activeCoordinatorOrg();
        IVolunteerHoursV1.V1Record memory original = v1.getRecord(v1Id);
        if (original.entryType != 0) revert NotV1Original(v1Id);
        if (original.issuer != msg.sender) revert NotV1Issuer(v1Id, msg.sender, original.issuer);
        uint16 hoursNow = _v1EffectiveHours(v1Id);

        delete v1LinkRequest[v1Id];
        id = _append(Record(0, 0, volunteer, hoursNow, EntryType.MigratedV1, category, orgId, msg.sender, uint64(block.timestamp), 0, 0, 0, bytes32(0), bytes32(0), v1Id));
        v1Migrated[v1Id] = id;
        _originals[volunteer].push(id);
        emit V1Migrated(v1Id, id, volunteer, hoursNow, category);
        _adjust(volunteer, category, 0, hoursNow);
    }

    /// Anyone: if the V1 record was corrected or revoked after migration, mirror that change in V2.
    function syncV1(uint256 v1Id) external returns (uint256 id) {
        uint256 first = v1Migrated[v1Id];
        if (first == 0) revert NotMigrated(v1Id);
        Record storage head = _head(first);
        if (head.entryType == EntryType.Revocation) revert RecordIsRevoked(head.id);
        uint16 v1Now = _v1EffectiveHours(v1Id);
        uint16 oldHours = head.hoursLogged;
        if (v1Now == oldHours) revert NothingToSync(v1Id);
        if (v1Now == 0) {
            id = _supersede(head, 0, EntryType.Revocation, V1_SYNC_REASON, address(this));
            emit RecordRevoked(id, head.id, head.volunteer, V1_SYNC_REASON);
        } else {
            id = _supersede(head, v1Now, EntryType.Correction, V1_SYNC_REASON, address(this));
            emit RecordCorrected(id, head.id, head.volunteer, v1Now, V1_SYNC_REASON);
        }
        _adjust(head.volunteer, head.category, oldHours, v1Now);
    }

    /// Anyone: re-run badge reconciliation (e.g. after a volunteer reclaims a renounced badge).
    function resyncBadges(address volunteer) external {
        for (uint8 c; c < CATEGORY_COUNT; c++) badges.sync(volunteer, totalHours[volunteer], c, _categoryHours[volunteer][c]);
    }

    // ---------- Views ----------

    function getOrg(uint256 orgId) external view returns (Org memory) {
        return _orgs[orgId];
    }

    function getEvent(uint256 eventId) external view returns (Event memory) {
        return _events[eventId];
    }

    function getRecord(uint256 recordId) external view returns (Record memory) {
        if (recordId == 0 || recordId > recordCount) revert RecordNotFound(recordId);
        return _records[recordId];
    }

    function headOf(uint256 recordId) external view returns (Record memory) {
        if (recordId == 0 || recordId > recordCount) revert RecordNotFound(recordId);
        return _head(recordId);
    }

    function categoryHours(address volunteer) external view returns (uint256[5] memory) {
        return _categoryHours[volunteer];
    }

    function originalsOf(address volunteer, uint256 offset, uint256 limit) external view returns (uint256[] memory ids, uint256 total) {
        uint256[] storage all = _originals[volunteer];
        total = all.length;
        uint256 end = offset + limit > total ? total : offset + limit;
        if (offset >= end) return (new uint256[](0), total);
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) ids[i - offset] = all[i];
    }

    // ---------- Internals ----------

    function _org(uint256 orgId) internal view returns (Org storage o) {
        if (orgId == 0 || orgId > orgCount) revert OrgNotFound(orgId);
        o = _orgs[orgId];
    }

    function _event(uint256 eventId) internal view returns (Event storage e) {
        if (eventId == 0 || eventId > eventCount) revert EventNotFound(eventId);
        e = _events[eventId];
    }

    function _requireOrgAdmin(uint256 orgId) internal view {
        Org storage o = _org(orgId);
        if (msg.sender != o.admin && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotOrgAdmin(orgId, msg.sender);
    }

    function _activeCoordinatorOrg() internal view returns (uint256 orgId) {
        orgId = coordinatorOrg[msg.sender];
        if (orgId == 0) revert NotCoordinator(msg.sender);
        if (_orgs[orgId].suspended) revert OrgIsSuspended(orgId);
    }

    function _chargeCaps(address volunteer, uint32 day, Category category, uint256 orgId, uint256 addHours) internal {
        uint16 cap = category == Category.Emergency ? EMERGENCY_DAILY_CAP : DAILY_CAP;
        uint256 v = dayHours[volunteer][day] + addHours;
        if (v > cap) revert DailyCapExceeded(volunteer, day, v, cap);
        dayHours[volunteer][day] = v;
        uint32 today = uint32(block.timestamp / 1 days);
        uint256 o = orgDayIssued[orgId][today] + addHours;
        uint32 orgCap = _orgs[orgId].dailyIssueCap;
        if (o > orgCap) revert OrgDailyCapExceeded(orgId, o, orgCap);
        orgDayIssued[orgId][today] = o;
    }

    function _append(Record memory r) internal returns (uint256 id) {
        id = ++recordCount;
        r.id = id;
        _records[id] = r;
    }

    function _head(uint256 recordId) internal view returns (Record storage r) {
        r = _records[recordId];
        while (r.supersededBy != 0) r = _records[r.supersededBy];
    }

    function _fixableHead(uint256 recordId) internal view returns (Record storage r) {
        if (recordId == 0 || recordId > recordCount) revert RecordNotFound(recordId);
        r = _records[recordId];
        if (r.supersededBy != 0) revert RecordAlreadySuperseded(recordId, r.supersededBy);
        if (r.entryType == EntryType.Revocation) revert RecordIsRevoked(recordId);
    }

    function _supersede(Record storage head, uint16 newHours, EntryType t, bytes32 reason, address issuer) internal returns (uint256 id) {
        id = _append(Record(0, head.eventId, head.volunteer, newHours, t, head.category, head.orgId, issuer, uint64(block.timestamp), head.serviceDay, head.id, 0, head.evidenceHash, reason, head.v1RecordId));
        head.supersededBy = id;
    }

    function _v1EffectiveHours(uint256 v1Id) internal view returns (uint16) {
        (IVolunteerHoursV1.V1Record memory h,) = v1.getEffectiveRecord(v1Id);
        // V1 walks at most MAX_TRAIL (25) entries per call; continue from where it stopped (found by Slither, unused-return)
        while (h.supersededBy != 0) (h,) = v1.getEffectiveRecord(h.id);
        return h.entryType == 2 ? 0 : h.hoursLogged;
    }

    /// The only place totals change: by the difference between a record's old and new effective hours.
    function _adjust(address volunteer, Category category, uint256 oldHours, uint256 newHours) internal {
        uint8 c = uint8(category);
        totalHours[volunteer] = totalHours[volunteer] + newHours - oldHours;
        _categoryHours[volunteer][c] = _categoryHours[volunteer][c] + newHours - oldHours;
        emit TotalsChanged(volunteer, totalHours[volunteer], category, _categoryHours[volunteer][c]);
        badges.sync(volunteer, totalHours[volunteer], c, _categoryHours[volunteer][c]);
    }
}
