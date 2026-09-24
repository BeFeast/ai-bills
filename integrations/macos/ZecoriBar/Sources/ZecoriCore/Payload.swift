import Foundation

/// The answer of GET /api/widget (src/lib/widget.ts). Every field is optional or defaulted so an
/// older or newer server never breaks the client: an unknown field is ignored, a missing one reads as absent.
public struct WidgetPayload: Decodable, Equatable {
    public var now: String?
    public var snapshot: SnapshotInfo?
    public var usage: UsageInfo?
    public var accounts: [Account]
    public var today: Today?

    enum CodingKeys: String, CodingKey { case now, snapshot, usage, accounts, today }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        now = try c.decodeIfPresent(String.self, forKey: .now)
        snapshot = try c.decodeIfPresent(SnapshotInfo.self, forKey: .snapshot)
        usage = try c.decodeIfPresent(UsageInfo.self, forKey: .usage)
        accounts = try c.decode([Account].self, forKey: .accounts)
        today = try c.decodeIfPresent(Today.self, forKey: .today)
    }
}

public struct SnapshotInfo: Decodable, Equatable {
    public var generatedAt: String?
    public var receivedAt: String?
    public var ageSeconds: Double?
    public var stale: Bool?
    public var reason: String?
}

public struct UsageInfo: Decodable, Equatable {
    public var refreshedAt: String?
    public var refreshing: Bool?
    public var timezone: String?
}

public struct Account: Decodable, Equatable, Identifiable {
    public var key: String
    public var provider: String
    public var label: String
    public var email: String?
    public var state: String
    public var message: String?
    public var observedAt: String?
    public var limiting: LimitWindow?
    public var headline: LimitWindow?
    public var windows: [LimitWindow]
    public var id: String { key }

    enum CodingKeys: String, CodingKey { case key, provider, label, email, state, message, observedAt, limiting, headline, windows }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        email = try c.decodeIfPresent(String.self, forKey: .email)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "unknown"
        message = try c.decodeIfPresent(String.self, forKey: .message)
        observedAt = try c.decodeIfPresent(String.self, forKey: .observedAt)
        limiting = try c.decodeIfPresent(LimitWindow.self, forKey: .limiting)
        headline = try c.decodeIfPresent(LimitWindow.self, forKey: .headline)
        windows = try c.decodeIfPresent([LimitWindow].self, forKey: .windows) ?? []
    }
}

public struct LimitWindow: Decodable, Equatable {
    public var label: String
    public var remaining: Double?
    public var remainingPercent: Double?
    public var unit: String?
    public var resetsAt: String?
    public var limiting: Bool?
    public var exhausted: Bool?
    public var tone: String?
    public var scoped: Bool?
    public var observedAt: String?
}

public struct Today: Decodable, Equatable {
    public var date: String
    public var byClient: [Client]
}

public struct Client: Decodable, Equatable {
    public var name: String
    public var tokens: Double?
    public var requests: Double?
    public var apiEquivalentUsd: Double?
    public var pricedApiEquivalentUsd: Double?
}

public enum PayloadDecoder {
    public static func decode(_ data: Data) throws -> WidgetPayload {
        try JSONDecoder().decode(WidgetPayload.self, from: data)
    }
}
