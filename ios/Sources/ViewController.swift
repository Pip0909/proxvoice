import UIKit
import WebKit
import AVFoundation

/// Thin native shell around the ProxVoice web app.
/// Why a native shell instead of Safari/PWA: with the "audio" background mode and an active
/// play-and-record audio session, iOS keeps the mic + voice running while the user is in Minecraft.
final class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private static let defaultURL = "https://proxvoice-en1q.onrender.com"
    private static let urlKey = "serverURL"

    private var web: WKWebView!
    private let spinner = UIActivityIndicatorView(style: .large)
    private let bg = UIColor(red: 15 / 255, green: 23 / 255, blue: 32 / 255, alpha: 1)

    private var serverURL: String {
        get { UserDefaults.standard.string(forKey: Self.urlKey) ?? Self.defaultURL }
        set { UserDefaults.standard.set(newValue, forKey: Self.urlKey) }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = bg

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        web = WKWebView(frame: .zero, configuration: config)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = bg
        web.scrollView.backgroundColor = bg
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        UIApplication.shared.isIdleTimerDisabled = true
        configureAudioSession()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(reactivateAudio),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(reactivateAudio),
                       name: AVAudioSession.interruptionNotification, object: nil)

        load()
    }

    // MARK: audio

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default,
                                    options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            NSLog("ProxVoice: audio session error \(error)")
        }
    }

    @objc private func reactivateAudio() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    // MARK: loading

    private func load() {
        guard let url = URL(string: serverURL) else { askServer(message: "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง"); return }
        spinner.startAnimating()
        web.load(URLRequest(url: url))
    }

    private func askServer(message: String?) {
        spinner.stopAnimating()
        let alert = UIAlertController(title: "ที่อยู่เซิร์ฟเวอร์", message: message, preferredStyle: .alert)
        alert.addTextField { tf in
            tf.text = self.serverURL
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "เชื่อมต่อ", style: .default) { _ in
            var t = (alert.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { t = Self.defaultURL }
            if !t.hasPrefix("http://") && !t.hasPrefix("https://") { t = "https://" + t }
            self.serverURL = t
            self.load()
        })
        alert.addAction(UIAlertAction(title: "ลองใหม่", style: .cancel) { _ in self.load() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        askServer(message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบที่อยู่แล้วลองใหม่")
    }

    // MARK: microphone prompt from the page (iOS 15+): the app-level permission prompt already covers it

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // window.open / target=_blank → stay in the same view
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}
