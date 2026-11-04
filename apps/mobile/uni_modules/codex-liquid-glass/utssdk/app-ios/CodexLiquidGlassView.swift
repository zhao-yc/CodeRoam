import UIKit

// 原生视图只处理玻璃材质和按键反馈，业务动作交回 uvue。
public final class CodexLiquidGlassView: UIView {
    private let surface = UIVisualEffectView()
    private let primary = UIButton(type: .system)
    private let secondary = UIButton(type: .system)
    private let decorative: Bool
    private let grouped: Bool
    private var activate: (() -> Void)?
    private var activateSecondary: (() -> Void)?

    public static func supportsGlass() -> Bool {
        if #available(iOS 26, *) { return true }
        return false
    }

    public init(decorative: Bool, grouped: Bool, activate: @escaping () -> Void, activateSecondary: @escaping () -> Void) {
        self.decorative = decorative
        self.grouped = grouped
        super.init(frame: .zero)
        guard #available(iOS 26, *) else { return }

        // 原生视图宿主会裁切外部阴影，按胶囊轮廓裁切以消除矩形边缘。
        cornerConfiguration = .capsule()
        clipsToBounds = true

        if decorative || grouped {
            let effect = UIGlassEffect(style: .regular)
            effect.isInteractive = grouped
            surface.effect = effect
            surface.cornerConfiguration = .capsule()
            addSubview(surface)
        }

        if decorative {
            // 装饰层位于输入内容后面，触控和 VoiceOver 都交给前景。
            isUserInteractionEnabled = false
            accessibilityElementsHidden = true
            return
        }

        self.activate = activate
        primary.addAction(UIAction { [weak self] _ in self?.activate?() }, for: .primaryActionTriggered)
        if grouped {
            self.activateSecondary = activateSecondary
            secondary.addAction(UIAction { [weak self] _ in self?.activateSecondary?() }, for: .primaryActionTriggered)
            surface.contentView.addSubview(primary)
            surface.contentView.addSubview(secondary)
        } else {
            addSubview(primary)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("请使用代码创建液态玻璃视图") }

    // 跟随 uni-app x 尺寸变化，始终平分搜索和连接设置的点击区域。
    public override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
        if grouped {
            let half = bounds.width / 2
            primary.frame = CGRect(x: 0, y: 0, width: half, height: bounds.height)
            secondary.frame = CGRect(x: half, y: 0, width: bounds.width - half, height: bounds.height)
        } else {
            primary.frame = bounds
        }
    }

    // 随草稿和任务状态刷新图标、VoiceOver 标签及禁用状态。
    public func update(symbol: String, label: String, title: String, prominent: Bool, disabled: Bool, busy: Bool, secondarySymbol: String, secondaryLabel: String, secondaryDisabled: Bool) {
        guard #available(iOS 26, *), !decorative else { return }
        configure(primary, symbol: symbol, label: label, title: title, prominent: prominent, disabled: disabled, busy: busy)
        if grouped {
            configure(secondary, symbol: secondarySymbol, label: secondaryLabel, title: "", prominent: false, disabled: secondaryDisabled, busy: false)
        }
    }

    // 解除绑定元素和原生视图之间的闭环，关闭聊天后释放回调。
    public func detach() {
        activate = nil
        activateSecondary = nil
    }

    @available(iOS 26, *)
    private func configure(_ button: UIButton, symbol: String, label: String, title: String, prominent: Bool, disabled: Bool, busy: Bool) {
        var configuration: UIButton.Configuration = grouped ? .plain() : prominent ? .prominentGlass() : .glass()
        configuration.cornerStyle = .capsule
        configuration.image = UIImage(systemName: symbol)
        configuration.showsActivityIndicator = busy
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        configuration.title = title.isEmpty ? nil : title
        configuration.imagePadding = 8
        let inset: CGFloat = title.isEmpty ? 0 : 16
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: inset, bottom: 0, trailing: inset)
        if prominent {
            configuration.baseBackgroundColor = UIColor(red: 69 / 255, green: 70 / 255, blue: 189 / 255, alpha: 1)
            configuration.baseForegroundColor = .white
        } else {
            configuration.baseForegroundColor = .label
        }
        button.configuration = configuration
        button.accessibilityLabel = label
        button.isEnabled = !disabled && !busy
    }
}
