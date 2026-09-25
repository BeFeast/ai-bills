import Foundation

/// Display rules shared with the Omarchy widget (integrations/omarchy/befeast.zecori/Panel.qml).
/// Each function mirrors the QML helper of the same name; keep them in step.
public struct Presenter {
    public var payload: WidgetPayload?
    public var errorText: String
    public var fetchedAt: Date?
    public var now: Date
    public var timeZone: TimeZone

    public init(payload: WidgetPayload?, errorText: String = "", fetchedAt: Date? = nil, now: Date = Date(), timeZone: TimeZone = .current) {
        self.payload = payload
        self.errorText = errorText
        self.fetchedAt = fetchedAt
        self.now = now
        self.timeZone = timeZone
    }

    public var accounts: [Account] { payload?.accounts ?? [] }
    public var models: [WidgetModel] { payload?.models ?? [] }

    /// The server's headline (tightest account-wide window), or the hero's limiting window from an older server.
    public static func headlineOf(_ account: Account?) -> LimitWindow? {
        guard let account else { return nil }
        return account.headline ?? account.limiting
    }

    /// The account whose headline has the least left decides the bar; the first wins a tie.
    public var worst: Account? {
        var best: Account?
        for account in accounts {
            guard let head = Self.headlineOf(account), let left = head.remainingPercent else { continue }
            if best == nil || left < (Self.headlineOf(best)?.remainingPercent ?? .infinity) { best = account }
        }
        return best
    }

    public var stale: Bool { payload?.snapshot?.stale == true }

    public var alarming: Bool {
        if !errorText.isEmpty || stale { return true }
        guard let head = Self.headlineOf(worst) else { return false }
        return head.tone == "bad" || head.exhausted == true
    }

    public var barLabel: String {
        if !errorText.isEmpty && payload == nil { return "!" }
        if payload == nil { return "…" }
        guard let head = Self.headlineOf(worst), let left = head.remainingPercent else { return "–" }
        return "\(Int(left.rounded()))%"
    }

    public var barTooltip: String {
        if !errorText.isEmpty { return "Zecori: \(errorText)" }
        if payload == nil { return "Zecori: loading" }
        guard let worst, let head = Self.headlineOf(worst), let left = head.remainingPercent else { return "Zecori: no limit windows observed" }
        return "Zecori: \(worst.label) · \(head.label) · \(Int(left.rounded()))% left" + modelsTooltip
    }

    /// The pool's answer per model, after the account headline: which account still has the model, or none.
    public var modelsTooltip: String {
        let parts = models.map { model -> String in
            if model.usable == true, let best = model.best, let left = best.remainingPercent { return "\(model.model) \(Int(left.rounded()))% (\(best.label))" }
            return "\(model.model) none"
        }
        return parts.isEmpty ? "" : " · " + parts.joined(separator: " · ")
    }

    // MARK: formatting

    public static func formatDuration(_ seconds: Double) -> String {
        guard seconds > 0 else { return "now" }
        let minutes = Int(floor(seconds / 60)), hours = minutes / 60, days = hours / 24
        if days > 0 { return "\(days)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(max(1, minutes))m"
    }

    public static func parseDate(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }

    public func resetIn(_ window: LimitWindow?) -> String { resetIn(at: window?.resetsAt) }

    public func resetIn(at text: String?) -> String {
        guard let at = Self.parseDate(text) else { return "" }
        let left = at.timeIntervalSince(now)
        return left > 0 ? "resets in \(Self.formatDuration(left))" : "reset due"
    }

    public func agoText(_ date: Date?) -> String {
        guard let date else { return "" }
        let diff = now.timeIntervalSince(date)
        if diff < 90 { return "just now" }
        return "\(Self.formatDuration(diff)) ago"
    }

    public func clock(_ text: String?) -> String {
        guard let date = Self.parseDate(text) else { return "" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    public static func remainingText(_ window: LimitWindow?) -> String {
        guard let window else { return "—" }
        if window.unit == "requests", let remaining = window.remaining { return "\(Int(remaining.rounded())) left" }
        guard let left = window.remainingPercent else { return "—" }
        return "\(Int(left.rounded()))% left"
    }

    /// Everything but the headline, in the server's order: account-wide windows, then the model-scoped ones.
    public func otherWindowsText(_ account: Account) -> String {
        let head = Self.headlineOf(account)
        var parts: [String] = []
        for window in account.windows {
            if let head, window.label == head.label { continue }
            var notes: [String] = []
            if window.resetsAt != nil, window.tone == "bad" || window.tone == "warn" { notes.append(resetIn(window)) }
            if window.observedAt != nil { notes.append("as of \(clock(window.observedAt))") }
            parts.append("\(window.label) \(Self.remainingText(window))" + (notes.isEmpty ? "" : " (\(notes.joined(separator: ", ")))"))
        }
        return parts.joined(separator: " · ")
    }

    // MARK: models (the pool view)

    /// The best account's remaining, or "none left" when no account answers for the model.
    public static func modelValueText(_ model: WidgetModel) -> String {
        if model.usable != true { return model.best == nil ? "—" : "none left" }
        guard let left = model.best?.remainingPercent else { return "—" }
        return "\(Int(left.rounded()))% left"
    }

    /// One account's chip: its label and what it has left, the reset when low, the observation time when carried.
    public func chipText(_ entry: ModelAccount) -> String {
        let value = entry.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—"
        var notes: [String] = []
        if entry.resetsAt != nil, entry.tone == "bad" || entry.tone == "warn" { notes.append(resetIn(at: entry.resetsAt)) }
        if entry.observedAt != nil { notes.append("as of \(clock(entry.observedAt))") }
        return "\(entry.label) \(value)" + (notes.isEmpty ? "" : " (\(notes.joined(separator: ", ")))")
    }

    /// Under the chips: which account answers for the model, or when the pool may answer again.
    public func modelLine(_ model: WidgetModel) -> String {
        if model.usable != true {
            let when = model.nextResetAt == nil ? "" : resetIn(at: model.nextResetAt)
            return "\(model.model): none left" + (when.isEmpty ? "" : " · \(when)")
        }
        guard let best = model.best else { return "" }
        var parts = ["\(model.model) via \(best.label)"]
        if best.observedAt != nil { parts.append("as of \(clock(best.observedAt))") }
        return parts.joined(separator: " · ")
    }

    public static func modelAlarming(_ model: WidgetModel) -> Bool { model.usable != true }

    public static func modelWarning(_ model: WidgetModel) -> Bool { model.usable == true && model.tone == "warn" }

    public static func modelMeterRatio(_ model: WidgetModel) -> Double? {
        guard let left = model.best?.remainingPercent else { return nil }
        return min(1, max(0, left / 100))
    }

    public static func stateText(_ account: Account) -> String {
        if account.state == "pending" { return "Waiting for the first observation" }
        if account.state == "fresh" { return "" }
        return account.message ?? account.state
    }

    /// The line under an account's meter: headline window, reset, carried time, state.
    public func headlineLine(_ account: Account) -> String {
        guard let head = Self.headlineOf(account) else { return Self.stateText(account) }
        var parts = [head.label]
        let reset = resetIn(head)
        if !reset.isEmpty { parts.append(reset) }
        if head.observedAt != nil { parts.append("as of \(clock(head.observedAt))") }
        let state = Self.stateText(account)
        if !state.isEmpty { parts.append(state) }
        return parts.joined(separator: " · ")
    }

    public static func valueText(_ account: Account) -> String {
        if let head = headlineOf(account) { return remainingText(head) }
        return account.state == "pending" ? "…" : "—"
    }

    /// Remaining fraction for the meter, or nil when the window has no percentage.
    public static func meterRatio(_ account: Account) -> Double? {
        guard let left = headlineOf(account)?.remainingPercent else { return nil }
        return min(1, max(0, left / 100))
    }

    public static func accountAlarming(_ account: Account) -> Bool {
        guard let head = headlineOf(account) else { return false }
        return head.tone == "bad" || head.exhausted == true
    }

    public static func accountWarning(_ account: Account) -> Bool { headlineOf(account)?.tone == "warn" }

    public static func stateIsUrgent(_ account: Account) -> Bool { account.state != "fresh" && account.state != "pending" }

    public var heroMeta: String {
        guard let payload else { return errorText.isEmpty ? "loading" : "not reachable" }
        var parts: [String] = []
        if let generated = payload.snapshot?.generatedAt { parts.append("snapshot \(clock(generated))") }
        if stale { parts.append(payload.snapshot?.reason == "no-snapshot" ? "no snapshot yet" : "stale") }
        if fetchedAt != nil { parts.append("read \(agoText(fetchedAt))") }
        return parts.joined(separator: " · ")
    }

    public var bannerText: String {
        if !errorText.isEmpty { return errorText }
        guard stale, let snapshot = payload?.snapshot else { return "" }
        if snapshot.reason == "no-snapshot" { return "Zecori has not received a snapshot for this tenant yet." }
        return "The collector snapshot is \(Self.formatDuration(snapshot.ageSeconds ?? 0)) old; limits may have moved since."
    }

    public var emptyText: String? {
        payload != nil && accounts.isEmpty ? "No accounts observed for this tenant yet." : nil
    }
}

/// The same failure wording as the Omarchy helper (zecori-fetch), so both systems say the same thing.
public enum FetchFailure {
    public static func message(status: Int, body: Data?) -> String {
        switch status {
        case 401: return "The device token was not accepted; issue a new one"
        case 403: return "This token may not read the widget; issue a device token, not an ingest token"
        default:
            var detail = ""
            if let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let error = object["error"] as? String { detail = ": \(error)" }
            return "Zecori answered HTTP \(status)\(detail)"
        }
    }
    public static let missingCredential = "No device token yet: open Settings and paste the token for this Mac"
    public static let unexpected = "Unexpected answer from /api/widget"
    public static func unreachable(_ base: String, _ reason: String) -> String { "Could not reach \(base): \(reason)" }
}
