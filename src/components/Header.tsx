type HeaderProps = {
  onOpenSettings: () => void;
};

function Header({ onOpenSettings }: HeaderProps) {
  return (
    <header className="app-header">
      <span className="app-brand">NovelCompany</span>
      <div className="header-actions">
        <span className="build-status">현재 상태: Development Build</span>
        <button className="settings-button" type="button" onClick={onOpenSettings}>
          설정
        </button>
      </div>
    </header>
  );
}

export default Header;
