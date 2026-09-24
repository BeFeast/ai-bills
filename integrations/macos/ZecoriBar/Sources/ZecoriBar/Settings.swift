import Foundation
import Security
import ServiceManagement
import SwiftUI

enum Defaults {
    static let baseURLKey = "baseURL"
    static let intervalKey = "refreshIntervalSec"
    static let defaultBaseURL = "https://zecori.befeast.com"
    static var baseURL: String {
        let value = UserDefaults.standard.string(forKey: baseURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (value.isEmpty ? defaultBaseURL : value).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }
    /// Same bounds as the Omarchy manifest: 60–3600 s, default 300 s.
    static var interval: TimeInterval {
        let value = UserDefaults.standard.integer(forKey: intervalKey)
        return TimeInterval(value == 0 ? 300 : min(3600, max(60, value)))
    }
}

/// The device token lives in the login Keychain. A token file in the Omarchy location
/// (~/.config/zecori/token, owner-only) is imported once so one setup works on both systems.
enum Credentials {
    private static let service = "com.befeast.zecori-bar"
    private static let account = "device"

    static func read() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8), !value.isEmpty else { return nil }
        return value
    }

    @discardableResult
    static func save(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        guard !trimmed.isEmpty else { return true }
        var add = base
        add[kSecValueData as String] = Data(trimmed.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func importLegacyFileIfNeeded() {
        guard read() == nil else { return }
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/zecori/token")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue, mode & 0o077 == 0,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { save(value) }
    }
}

struct SettingsView: View {
    @ObservedObject var store: WidgetStore
    @State private var tokenInput = ""
    @State private var saved = Credentials.read() != nil
    @AppStorage(Defaults.baseURLKey) private var baseURL = Defaults.defaultBaseURL
    @AppStorage(Defaults.intervalKey) private var interval = 300
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError = ""

    var body: some View {
        Form {
            Section {
                SecureField(saved ? "Saved — paste a new token to replace it" : "zd_…", text: $tokenInput)
                HStack {
                    Button("Save token") {
                        if Credentials.save(tokenInput) { saved = !tokenInput.isEmpty; tokenInput = ""; store.refresh() }
                    }.disabled(tokenInput.trimmingCharacters(in: .whitespaces).isEmpty)
                    if saved { Button("Remove") { Credentials.save(""); saved = false; store.refresh() } }
                    Spacer()
                    Text(saved ? "Stored in the Keychain" : "No token yet").foregroundStyle(.secondary).font(.caption)
                }
            } header: { Text("Device token") } footer: {
                Text("A read-only token for this Mac, issued by a tenant admin. It can read the widget and nothing else.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Instance") {
                TextField("Zecori URL", text: $baseURL)
                Stepper("Refresh every \(interval / 60) min", value: $interval, in: 60...3600, step: 60)
            }
            Section("System") {
                Toggle("Launch at login", isOn: $launchAtLogin).onChange(of: launchAtLogin) { _, enabled in
                    do { if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }; loginError = "" }
                    catch { loginError = error.localizedDescription; launchAtLogin = SMAppService.mainApp.status == .enabled }
                }
                if !loginError.isEmpty { Text(loginError).font(.caption).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .onChange(of: interval) { _, _ in store.restartTimer() }
    }
}
