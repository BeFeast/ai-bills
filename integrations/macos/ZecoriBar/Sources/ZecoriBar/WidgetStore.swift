import Foundation
import ZecoriCore

/// Polls GET /api/widget like the Omarchy widget: on start, every interval (default 300 s), on panel
/// open when the last read is older than 60 s, and on demand. The last good payload survives an error.
@MainActor
final class WidgetStore: ObservableObject {
    @Published private(set) var payload: WidgetPayload?
    @Published private(set) var errorText = ""
    @Published private(set) var fetchedAt: Date?
    @Published private(set) var busy = false
    @Published var now = Date()
    private var pollTimer: Timer?
    private var clockTimer: Timer?

    var presenter: Presenter { Presenter(payload: payload, errorText: errorText, fetchedAt: fetchedAt, now: now) }

    func start() {
        restartTimer()
        refresh()
    }

    func restartTimer() {
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: Defaults.interval, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        timer.tolerance = 10
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// While the panel is open, countdowns move every 30 s.
    func panelOpened() {
        now = Date()
        if fetchedAt == nil || Date().timeIntervalSince(fetchedAt!) > 60 { refresh() }
        clockTimer?.invalidate()
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.now = Date() } }
        RunLoop.main.add(timer, forMode: .common)
        clockTimer = timer
    }

    func panelClosed() {
        clockTimer?.invalidate()
        clockTimer = nil
    }

    func refresh() {
        guard !busy else { return }
        guard let token = Credentials.read() else {
            errorText = FetchFailure.missingCredential
            now = Date()
            return
        }
        busy = true
        let base = Defaults.baseURL
        Task {
            let result = await Self.fetch(base: base, token: token)
            busy = false
            now = Date()
            switch result {
            case .success(let payload):
                self.payload = payload
                errorText = ""
                fetchedAt = Date()
            case .failure(let message):
                errorText = message
            }
        }
    }

    enum Outcome { case success(WidgetPayload), failure(String) }

    nonisolated static func fetch(base: String, token: String) async -> Outcome {
        guard let url = URL(string: base + "/api/widget"), url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            return .failure("The Zecori URL must be https")
        }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 30
        do {
            let (data, response) = try await URLSession(configuration: configuration).data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else { return .failure(FetchFailure.message(status: status, body: data)) }
            guard let payload = try? PayloadDecoder.decode(data) else { return .failure(FetchFailure.unexpected) }
            return .success(payload)
        } catch {
            return .failure(FetchFailure.unreachable(base, error.localizedDescription))
        }
    }

    /// Test and render hook.
    func load(_ payload: WidgetPayload?, error: String = "", fetchedAt: Date?, now: Date) {
        self.payload = payload
        self.errorText = error
        self.fetchedAt = fetchedAt
        self.now = now
    }
}
