import XCTest
@testable import ZecoriCore

final class PresenterTests: XCTestCase {
    private func fixture() throws -> WidgetPayload {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "widget-payload", withExtension: "json", subdirectory: "Fixtures"))
        return try PayloadDecoder.decode(Data(contentsOf: url))
    }
    private let now = Presenter.parseDate("2026-09-24T14:00:00.000Z")!
    private let utc = TimeZone(identifier: "UTC")!

    func testBarLeadsWithTheTightestAccountWideWindowNotTheModelScopedOne() throws {
        let p = Presenter(payload: try fixture(), now: now, timeZone: utc)
        XCTAssertEqual(p.worst?.key, "claude-personal")
        XCTAssertEqual(p.barLabel, "19%")
        XCTAssertEqual(p.barTooltip, "Zecori: Claude · Personal · Weekly all models · 19% left")
        XCTAssertFalse(p.alarming, "warn is not urgent; a 0 % Fable weekly must not turn the bar red")
    }

    func testAccountLinesMatchTheOmarchyPanel() throws {
        let p = Presenter(payload: try fixture(), now: now, timeZone: utc)
        let personal = p.accounts[0]
        XCTAssertEqual(Presenter.valueText(personal), "19% left")
        XCTAssertEqual(p.headlineLine(personal), "Weekly all models · resets in 3h 0m")
        XCTAssertEqual(p.otherWindowsText(personal), "Session 88% left · Fable weekly 0% left (resets in 3h 0m, as of 13:52)")
        XCTAssertEqual(Presenter.meterRatio(personal), 0.19)
        XCTAssertTrue(Presenter.accountWarning(personal))
        let codex = p.accounts[2]
        XCTAssertEqual(p.headlineLine(codex), "Weekly · resets in 2d 1h")
        XCTAssertEqual(p.otherWindowsText(codex), "")
        let kimi = p.accounts[4]
        XCTAssertEqual(Presenter.valueText(kimi), "—")
        XCTAssertEqual(p.headlineLine(kimi), "invalid user token: token is expired")
        XCTAssertTrue(Presenter.stateIsUrgent(kimi))
        let cursor = p.accounts[5]
        XCTAssertEqual(Presenter.valueText(cursor), "…")
        XCTAssertEqual(p.headlineLine(cursor), "Waiting for the first observation")
        XCTAssertFalse(Presenter.stateIsUrgent(cursor))
    }

    func testHeroBannerAndErrorStates() throws {
        let fetched = now.addingTimeInterval(-40)
        var p = Presenter(payload: try fixture(), fetchedAt: fetched, now: now, timeZone: utc)
        XCTAssertEqual(p.heroMeta, "snapshot 13:57 · read just now")
        XCTAssertEqual(p.bannerText, "")
        p.errorText = "The device token was not accepted; issue a new one"
        XCTAssertTrue(p.alarming)
        XCTAssertEqual(p.bannerText, p.errorText)
        let none = Presenter(payload: nil, errorText: "boom", now: now)
        XCTAssertEqual(none.barLabel, "!")
        XCTAssertEqual(none.heroMeta, "not reachable")
        XCTAssertEqual(Presenter(payload: nil, now: now).barLabel, "…")
    }

    func testStaleSnapshotIsUrgentAndOlderServersFallBackToLimiting() throws {
        var payload = try fixture()
        payload.snapshot?.stale = true
        payload.snapshot?.reason = "snapshot-age"
        payload.snapshot?.ageSeconds = 1200
        let p = Presenter(payload: payload, now: now, timeZone: utc)
        XCTAssertTrue(p.alarming)
        XCTAssertEqual(p.bannerText, "The collector snapshot is 20m old; limits may have moved since.")
        payload.snapshot?.stale = false
        for i in payload.accounts.indices { payload.accounts[i].headline = nil }
        XCTAssertEqual(Presenter(payload: payload, now: now).barLabel, "0%")
    }

    func testFormattingAndFailureWording() {
        XCTAssertEqual(Presenter.formatDuration(0), "now")
        XCTAssertEqual(Presenter.formatDuration(30), "1m")
        XCTAssertEqual(Presenter.formatDuration(3 * 3600 + 5 * 60), "3h 5m")
        XCTAssertEqual(Presenter.formatDuration(2 * 86400 + 3600), "2d 1h")
        XCTAssertEqual(FetchFailure.message(status: 401, body: nil), "The device token was not accepted; issue a new one")
        XCTAssertEqual(FetchFailure.message(status: 503, body: Data(#"{"error":"Widget data unavailable"}"#.utf8)), "Zecori answered HTTP 503: Widget data unavailable")
    }

    func testUnknownFieldsAndMissingOptionalsDecode() throws {
        let json = #"{"accounts":[{"key":"x","state":"fresh","future":1,"windows":[{"label":"W","remainingPercent":50,"new":true}]}],"extra":{}}"#
        let payload = try PayloadDecoder.decode(Data(json.utf8))
        XCTAssertEqual(payload.accounts.first?.label, "x")
        XCTAssertEqual(Presenter(payload: payload, now: now).barLabel, "–")
    }
}
