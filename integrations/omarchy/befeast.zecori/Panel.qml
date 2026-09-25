import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Zecori in the bar: the tightest remaining allowance next to the mark, and a
// panel with every account's limit windows and today's spend by client label.
// The panel is strictly a display of what `GET /api/widget` answers; the
// device token lives in a private file and never touches shell.json.
Panel {
  id: root
  moduleName: "befeast.zecori"
  ipcTarget: "befeast.zecori"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color surface: Color.popups.background
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string baseUrl: String(root.setting("baseUrl", "https://zecori.befeast.com"))
  readonly property string tokenPath: String(root.setting("tokenPath", "~/.config/zecori/token"))
  readonly property int refreshIntervalSec: Math.max(60, Number(root.setting("refreshIntervalSec", 300)) || 300)
  readonly property string glyphName: String(root.setting("glyph", "coin")) === "face" ? "face" : "coin"
  readonly property string fetchScript: Qt.resolvedUrl("zecori-fetch").toString().replace(/^file:\/\//, "")

  // The last answer, or the last failure: the panel keeps showing the previous
  // numbers under an error banner rather than going blank on one bad poll.
  property var payload: null
  property string errorText: ""
  property int errorStatus: 0
  property double fetchedAtMs: 0
  property bool busy: false
  property string stdoutText: ""
  property string stderrText: ""

  // Countdowns and "updated" read this instead of Date.now() so the panel keeps
  // telling the truth while it sits open.
  property double nowMs: Date.now()

  readonly property var accounts: payload && payload.accounts ? payload.accounts : []
  readonly property var todayRows: payload && payload.today && payload.today.byClient ? payload.today.byClient : []
  // Model-scoped allowances across the pool (Claude's per-model weekly); an older server sends none.
  readonly property var models: payload && payload.models ? payload.models : []
  readonly property var worst: worstAccount(accounts)
  readonly property bool stale: !!payload && !!payload.snapshot && payload.snapshot.stale === true
  readonly property bool alarming: errorText !== "" || stale || (!!worst && !!headlineOf(worst) && (headlineOf(worst).tone === "bad" || headlineOf(worst).exhausted === true))

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  // ---------------------------------------------------------------- data

  function refreshNow() {
    if (busy) return
    busy = true
    stdoutText = ""
    stderrText = ""
    fetchProcess.command = [root.fetchScript, root.baseUrl, root.tokenPath]
    fetchProcess.running = true
    fetchTimeout.restart()
  }

  function finishFetch() {
    fetchTimeout.stop()
    busy = false
    nowMs = Date.now()
    var parsed = null
    try { parsed = JSON.parse(stdoutText) } catch (error) { parsed = null }
    if (!parsed || typeof parsed !== "object") {
      errorText = stderrText.trim() !== "" ? stderrText.trim() : "The fetch helper returned nothing"
      errorStatus = 0
      return
    }
    if (parsed.error !== undefined) {
      errorText = String(parsed.error)
      errorStatus = Number(parsed.status) || 0
      return
    }
    payload = parsed
    errorText = ""
    errorStatus = 0
    fetchedAtMs = Date.now()
  }

  // The window an account leads with: the server's headline (tightest account-wide window),
  // or the hero's limiting window from an instance that does not send a headline yet.
  function headlineOf(account) {
    if (!account) return null
    return account.headline || account.limiting || null
  }

  // The account whose headline window has the least left decides the bar label.
  function worstAccount(list) {
    var best = null
    for (var i = 0; i < list.length; i++) {
      var entry = list[i]
      var head = headlineOf(entry)
      if (!head || head.remainingPercent === null || head.remainingPercent === undefined) continue
      if (!best || Number(head.remainingPercent) < Number(headlineOf(best).remainingPercent)) best = entry
    }
    return best
  }

  function barLabel() {
    if (errorText !== "" && !payload) return "!"
    if (!payload) return "…"
    if (!worst) return "–"
    return Math.round(Number(headlineOf(worst).remainingPercent)) + "%"
  }

  function barTooltip() {
    if (errorText !== "") return "Zecori: " + errorText
    if (!payload) return "Zecori: loading"
    if (!worst) return "Zecori: no limit windows observed"
    return "Zecori: " + worst.label + " · " + headlineOf(worst).label + " · " + Math.round(Number(headlineOf(worst).remainingPercent)) + "% left" + modelsTooltip()
  }

  // The pool's answer per model, after the account headline: which account still has the model, or none.
  function modelsTooltip() {
    var parts = []
    for (var i = 0; i < models.length; i++) {
      var m = models[i]
      if (m.usable === true && m.best) parts.push(String(m.model) + " " + Math.round(Number(m.best.remainingPercent)) + "% (" + String(m.best.label) + ")")
      else parts.push(String(m.model) + " none")
    }
    return parts.length ? " · " + parts.join(" · ") : ""
  }

  // ---------------------------------------------------------------- formatting

  function formatDuration(ms) {
    if (!(ms > 0)) return "now"
    var minutes = Math.floor(ms / 60000)
    var hours = Math.floor(minutes / 60)
    var days = Math.floor(hours / 24)
    if (days > 0) return days + "d " + (hours % 24) + "h"
    if (hours > 0) return hours + "h " + (minutes % 60) + "m"
    return Math.max(1, minutes) + "m"
  }

  function resetIn(window) {
    if (!window || !window.resetsAt) return ""
    var ms = new Date(String(window.resetsAt)).getTime()
    if (!isFinite(ms)) return ""
    return ms - root.nowMs > 0 ? "resets in " + formatDuration(ms - root.nowMs) : "reset due"
  }

  function agoText(ms) {
    if (!(ms > 0)) return ""
    var diff = root.nowMs - ms
    if (diff < 90000) return "just now"
    return formatDuration(diff) + " ago"
  }

  function clock(iso) {
    var d = new Date(String(iso || ""))
    if (isNaN(d.getTime())) return ""
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
  }

  function formatMoney(value) {
    var amount = Number(value)
    if (!isFinite(amount)) return "—"
    if (amount > 0 && amount < 0.01) return "<$0.01"
    return "$" + amount.toFixed(2)
  }

  function formatTokens(value) {
    var n = Number(value) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return Math.round(n / 1e3) + "k"
    return String(n)
  }

  function remainingText(window) {
    if (!window) return "—"
    if (window.unit === "requests" && window.remaining !== null && window.remaining !== undefined) return Math.round(Number(window.remaining)) + " left"
    if (window.remainingPercent === null || window.remainingPercent === undefined) return "—"
    return Math.round(Number(window.remainingPercent)) + "% left"
  }

  // Everything but the headline, in the server's order: account-wide windows, then the model-scoped ones.
  function otherWindowsText(account) {
    if (!account || !account.windows) return ""
    var parts = []
    for (var i = 0; i < account.windows.length; i++) {
      var w = account.windows[i]
      var head = headlineOf(account)
      if (!w || (head && w.label === head.label)) continue
      // A low window says when it refills; a window carried from an earlier observation says when it was seen.
      var notes = []
      if (w.resetsAt && (w.tone === "bad" || w.tone === "warn")) notes.push(resetIn(w))
      if (w.observedAt) notes.push("as of " + clock(w.observedAt))
      parts.push(w.label + " " + remainingText(w) + (notes.length ? " (" + notes.join(", ") + ")" : ""))
    }
    return parts.join(" · ")
  }

  // ---------------------------------------------------------------- models (the pool view)

  // The best account's remaining, or "none left" when no account answers for the model.
  function modelValueText(model) {
    if (!model) return "—"
    if (model.usable !== true) return model.best ? "none left" : "—"
    return remainingText(model.best)
  }

  // One account's chip: its label and what it has left, the reset when low, the observation time when carried.
  function chipText(entry) {
    if (!entry) return ""
    var value = entry.remainingPercent === null || entry.remainingPercent === undefined ? "—" : Math.round(Number(entry.remainingPercent)) + "%"
    var notes = []
    if (entry.resetsAt && (entry.tone === "bad" || entry.tone === "warn")) notes.push(resetIn(entry))
    if (entry.observedAt) notes.push("as of " + clock(entry.observedAt))
    return String(entry.label) + " " + value + (notes.length ? " (" + notes.join(", ") + ")" : "")
  }

  // Under the chips: which account answers for the model, or when the pool may answer again.
  function modelLine(model) {
    if (!model) return ""
    if (model.usable !== true) {
      var when = model.nextResetAt ? resetIn({ resetsAt: model.nextResetAt }) : ""
      return String(model.model) + ": none left" + (when !== "" ? " · " + when : "")
    }
    var parts = [String(model.model) + " via " + String(model.best.label)]
    if (model.best.observedAt) parts.push("as of " + clock(model.best.observedAt))
    return parts.join(" · ")
  }

  function modelAlarming(model) { return !!model && model.usable !== true }
  function modelWarning(model) { return !!model && model.usable === true && model.tone === "warn" }

  function modelMeterRatio(model) {
    if (!model || !model.best || model.best.remainingPercent === null || model.best.remainingPercent === undefined) return -1
    return clamp(Number(model.best.remainingPercent) / 100, 0, 1)
  }

  function stateText(account) {
    if (!account) return ""
    if (account.state === "pending") return "Waiting for the first observation"
    if (account.state === "fresh") return ""
    return account.message ? String(account.message) : String(account.state)
  }

  function heroMeta() {
    if (!payload) return errorText !== "" ? "not reachable" : "loading"
    var parts = []
    if (payload.snapshot && payload.snapshot.generatedAt) parts.push("snapshot " + clock(payload.snapshot.generatedAt))
    if (stale) parts.push(payload.snapshot.reason === "no-snapshot" ? "no snapshot yet" : "stale")
    if (fetchedAtMs > 0) parts.push("read " + agoText(fetchedAtMs))
    return parts.join(" · ")
  }

  function bannerText() {
    if (errorText !== "") return errorText
    if (stale && payload.snapshot.reason === "no-snapshot") return "Zecori has not received a snapshot for this tenant yet."
    if (stale) return "The collector snapshot is " + formatDuration(Number(payload.snapshot.ageSeconds) * 1000) + " old; limits may have moved since."
    return ""
  }

  function todayTotal() {
    var total = 0
    for (var i = 0; i < todayRows.length; i++) total += Number(todayRows[i].pricedApiEquivalentUsd) || 0
    return total
  }

  function todayPeak() {
    var peak = 0
    for (var i = 0; i < todayRows.length; i++) peak = Math.max(peak, Number(todayRows[i].tokens) || 0)
    return peak
  }

  // ---------------------------------------------------------------- lifecycle

  implicitWidth: barRow.implicitWidth
  implicitHeight: bar ? bar.barSize : 26

  onOpenedChanged: if (opened) {
    nowMs = Date.now()
    if (panelFlick) panelFlick.contentY = 0
    if (fetchedAtMs === 0 || Date.now() - fetchedAtMs > 60000) refreshNow()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshNow()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Timer {
    id: fetchTimeout
    interval: 30000
    onTriggered: {
      fetchProcess.running = false
      root.busy = false
      root.errorText = "The fetch helper did not answer in time"
    }
  }

  Process {
    id: fetchProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.stdoutText = text
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.stderrText = text
    }
    onExited: function(exitCode) { root.finishFetch() }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
  }

  // ---------------------------------------------------------------- bar

  Row {
    id: barRow
    anchors.verticalCenter: parent.verticalCenter
    spacing: 0

    BarIconButton {
      id: button
      bar: root.bar
      active: root.alarming
      tooltipText: root.barTooltip()
      // A schematic monochrome mark in the bar's own colour, like every other bar icon; the
      // portrait stays for the panel hero. The SVG fills the icon canvas (its ink is about the
      // height of the cpu and monitor glyphs) and is decoded at physical pixels so it stays crisp
      // on fractional scales. The image is a hidden layer the effect samples.
      iconComponent: Component {
        Item {
          Image {
            id: glyph
            anchors.fill: parent
            source: Qt.resolvedUrl("assets/zecori-glyph-" + root.glyphName + ".svg")
            sourceSize.width: Math.round(Math.max(1, width) * Screen.devicePixelRatio)
            sourceSize.height: Math.round(Math.max(1, height) * Screen.devicePixelRatio)
            fillMode: Image.PreserveAspectFit
            smooth: true
            visible: false
            layer.enabled: true
          }
          MultiEffect {
            anchors.fill: glyph
            source: glyph
            colorization: 1.0
            // The button's own colours: what every other bar icon is painted with, urgent included.
            colorizationColor: button.active && button.useActiveColor ? button.activeColor : button.foreground
          }
        }
      }
      onPressed: function(buttonCode) {
        if (buttonCode === Qt.MiddleButton) root.refreshNow()
        else root.toggle()
      }
    }

    WidgetButton {
      id: labelButton
      bar: root.bar
      text: root.barLabel()
      active: root.alarming
      horizontalMargin: 4
      tooltipText: root.barTooltip()
      onPressed: function(buttonCode) {
        if (buttonCode === Qt.MiddleButton) root.refreshNow()
        else root.toggle()
      }
    }
  }

  // ---------------------------------------------------------------- panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // The shell already limits the panel to the screen; the cap only keeps a very tall screen from a wall of text.
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(960))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dy !== 0)
          panelFlick.contentY = root.clamp(panelFlick.contentY + dy * Style.space(56), 0,
                                           Math.max(0, panelFlick.contentHeight - panelFlick.height))
      }
      onActivateRequested: root.refreshNow()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { if (t === "r" || t === "R") root.refreshNow() }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Zecori"
            meta: root.heroMeta()
            detail: root.busy ? "refreshing" : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Image {
                width: Style.font.display
                height: Style.font.display
                source: Qt.resolvedUrl("assets/zecori-mark.png")
                sourceSize.width: Style.font.display * 2
                sourceSize.height: Style.font.display * 2
                fillMode: Image.PreserveAspectFit
                smooth: true
              }
            }
          }

          BorderSurface {
            visible: root.bannerText() !== ""
            width: parent.width
            implicitHeight: bannerLabel.implicitHeight + Style.spacing.xl * 2
            color: root.alpha(root.urgent, 0.10)
            borderSpec: Border.flat(root.alpha(root.urgent, 0.35), 1)
            radius: Style.cornerRadius

            Text {
              id: bannerLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: root.bannerText()
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Text {
            visible: root.accounts.length === 0 && !!root.payload
            width: parent.width
            topPadding: Style.space(12)
            text: "No accounts observed for this tenant yet."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          // ---------- Accounts ----------
          PanelSeparator {
            visible: root.accounts.length > 0
            foreground: root.foreground
          }

          Column {
            id: accountsSection
            visible: root.accounts.length > 0
            width: parent.width
            spacing: Style.space(12)

            PanelSectionHeader {
              width: parent.width
              text: "LIMITS NOW"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.accounts

              AccountRow {
                required property var modelData
                width: accountsSection.width
                account: modelData
              }
            }
          }

          // ---------- Models across the pool ----------
          PanelSeparator {
            visible: modelsSection.visible
            foreground: root.foreground
          }

          Column {
            id: modelsSection
            visible: root.models.length > 0
            width: parent.width
            spacing: Style.space(12)

            PanelSectionHeader {
              width: parent.width
              text: "MODELS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.models

              ModelRow {
                required property var modelData
                width: modelsSection.width
                entry: modelData
              }
            }
          }

          // ---------- Today by client ----------
          PanelSeparator {
            visible: todaySection.visible
            foreground: root.foreground
          }

          Column {
            id: todaySection
            visible: root.todayRows.length > 0
            width: parent.width
            spacing: Style.spacing.md

            readonly property real peak: Math.max(1, root.todayPeak())

            Item {
              width: parent.width
              implicitHeight: todayHeader.implicitHeight

              PanelSectionHeader {
                id: todayHeader
                text: "TODAY BY CLIENT"
                foreground: root.foreground
                fontFamily: root.fontFamily
                anchors.left: parent.left
              }

              Text {
                textFormat: Text.PlainText
                text: root.formatMoney(root.todayTotal()) + " api-equivalent"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                anchors.right: parent.right
                anchors.baseline: todayHeader.baseline
              }
            }

            Repeater {
              model: root.todayRows

              ClientRow {
                required property var modelData
                width: todaySection.width
                row: modelData
                share: (Number(modelData.tokens) || 0) / todaySection.peak
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            topPadding: Style.space(2)
            text: "r refresh · j/k scroll · esc close"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }

  // One account: name, limiting window with its meter and reset, the other windows in a line.
  component AccountRow: Column {
    id: accountRow
    property var account: null

    readonly property var limiting: root.headlineOf(account)
    readonly property bool alarming: !!limiting && (limiting.tone === "bad" || limiting.exhausted === true)
    readonly property bool warning: !!limiting && limiting.tone === "warn"
    readonly property real ratio: limiting && limiting.remainingPercent !== null && limiting.remainingPercent !== undefined
      ? root.clamp(Number(limiting.remainingPercent) / 100, 0, 1) : -1

    spacing: Style.space(5)

    Item {
      width: parent.width
      implicitHeight: Math.max(accountLabel.implicitHeight, accountValue.implicitHeight)

      Text {
        id: accountLabel
        textFormat: Text.PlainText
        text: accountRow.account ? String(accountRow.account.label) : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        elide: Text.ElideRight
        anchors.left: parent.left
        anchors.right: accountValue.left
        anchors.rightMargin: Style.spacing.sm
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: accountValue
        textFormat: Text.PlainText
        text: accountRow.limiting ? root.remainingText(accountRow.limiting) : (accountRow.account && accountRow.account.state === "pending" ? "…" : "—")
        color: accountRow.alarming ? root.urgent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: accountRow.alarming || accountRow.warning
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Meter {
      visible: accountRow.ratio >= 0
      width: parent.width
      value: accountRow.ratio
      alarming: accountRow.alarming
    }

    Text {
      textFormat: Text.PlainText
      visible: text !== ""
      width: parent.width
      text: {
        if (!accountRow.limiting) return root.stateText(accountRow.account)
        var parts = [String(accountRow.limiting.label)]
        var reset = root.resetIn(accountRow.limiting)
        if (reset !== "") parts.push(reset)
        if (accountRow.limiting.observedAt) parts.push("as of " + root.clock(accountRow.limiting.observedAt))
        var state = root.stateText(accountRow.account)
        if (state !== "") parts.push(state)
        return parts.join(" · ")
      }
      color: accountRow.account && accountRow.account.state !== "fresh" && accountRow.account.state !== "pending" ? root.urgent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      textFormat: Text.PlainText
      visible: text !== ""
      width: parent.width
      text: root.otherWindowsText(accountRow.account)
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      // Wraps rather than elides: the reset time and "as of" sit at the end of this line.
      wrapMode: Text.WordWrap
    }
  }

  // One model across the pool: the best account's remaining with its meter, a chip per account, then which account answers.
  component ModelRow: Column {
    id: modelRow
    property var entry: null

    readonly property bool alarming: root.modelAlarming(entry)
    readonly property bool warning: root.modelWarning(entry)
    readonly property real ratio: root.modelMeterRatio(entry)

    spacing: Style.space(5)

    Item {
      width: parent.width
      implicitHeight: Math.max(modelLabel.implicitHeight, modelValue.implicitHeight)

      Text {
        id: modelLabel
        textFormat: Text.PlainText
        text: modelRow.entry ? String(modelRow.entry.label) : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        elide: Text.ElideRight
        anchors.left: parent.left
        anchors.right: modelValue.left
        anchors.rightMargin: Style.spacing.sm
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: modelValue
        textFormat: Text.PlainText
        text: root.modelValueText(modelRow.entry)
        color: modelRow.alarming ? root.urgent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: modelRow.alarming || modelRow.warning
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Meter {
      visible: modelRow.ratio >= 0
      width: parent.width
      value: modelRow.ratio
      alarming: modelRow.alarming
    }

    Flow {
      width: parent.width
      spacing: Style.space(6)

      Repeater {
        model: modelRow.entry && modelRow.entry.accounts ? modelRow.entry.accounts : []

        Chip {
          required property var modelData
          entry: modelData
          maxWidth: modelRow.width
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      visible: text !== ""
      width: parent.width
      text: root.modelLine(modelRow.entry)
      color: modelRow.alarming ? root.urgent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // One account inside a model row: urgent when it has nothing left, bold when low, hollow when it reports no window.
  // A chip wider than the row wraps rather than elides: the reset and "as of" sit at the end of its text.
  component Chip: Rectangle {
    id: chip
    property var entry: null
    property real maxWidth: 0

    readonly property bool bad: !!entry && entry.tone === "bad"
    readonly property bool warn: !!entry && entry.tone === "warn"
    readonly property bool unknown: !entry || entry.remainingPercent === null || entry.remainingPercent === undefined
    readonly property real padding: Style.space(8)

    implicitWidth: Math.min(chipMetrics.advanceWidth + 1, Math.max(0, maxWidth - padding * 2)) + padding * 2
    implicitHeight: chipLabel.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: bad ? root.alpha(root.urgent, 0.12) : root.alpha(root.foreground, unknown ? 0 : 0.07)
    border.width: 1
    border.color: bad ? root.alpha(root.urgent, 0.45) : root.alpha(root.foreground, unknown ? 0.25 : 0.12)

    TextMetrics {
      id: chipMetrics
      font: chipLabel.font
      text: chipLabel.text
    }

    Text {
      id: chipLabel
      textFormat: Text.PlainText
      width: parent.width - chip.padding * 2
      anchors.centerIn: parent
      text: root.chipText(chip.entry)
      color: chip.bad ? root.urgent : (chip.unknown ? root.dim : root.foreground)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: chip.bad || chip.warn
      wrapMode: Text.WordWrap
    }
  }

  // Rounded track that drains as the allowance is used up: what is left is what is painted.
  component Meter: Item {
    id: meter
    property real value: -1
    property bool alarming: false
    property real thickness: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    implicitHeight: thickness

    Rectangle {
      id: meterTrack
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      anchors.left: meterTrack.left
      anchors.verticalCenter: meterTrack.verticalCenter
      height: meterTrack.height
      radius: meterTrack.radius
      width: meterTrack.width * root.clamp(meter.value, 0, 1)
      color: meter.alarming ? root.urgent : root.foreground

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }
  }

  // One client label of today's ledger, the share bar behind the row scaled to the heaviest client.
  component ClientRow: Item {
    id: clientRow
    property var row: null
    property real share: 0

    implicitHeight: clientName.implicitHeight + Style.spacing.lg

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: root.alpha(root.foreground, 0.05)
    }

    Rectangle {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: parent.width * root.clamp(clientRow.share, 0, 1)
      radius: Style.cornerRadius
      color: root.alpha(root.foreground, 0.14)

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }

    Text {
      id: clientName
      textFormat: Text.PlainText
      text: clientRow.row ? String(clientRow.row.name) : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      anchors.left: parent.left
      anchors.right: clientValue.left
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.spacing.sm
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      id: clientValue
      textFormat: Text.PlainText
      text: clientRow.row
        ? root.formatMoney(clientRow.row.pricedApiEquivalentUsd) + " · " + root.formatTokens(clientRow.row.tokens) + " tok · " + (Number(clientRow.row.requests) || 0) + " req"
        : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }
  }
}
