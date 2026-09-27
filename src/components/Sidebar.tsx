export type NavigationItem =
  | "company"
  | "works"
  | "workManagement"
  | "concept"
  | "employees"
  | "settings";

const navigationItems: Array<{ id: NavigationItem; label: string }> = [
  { id: "company", label: "회사" },
  { id: "workManagement", label: "작품 관리" },
  { id: "works", label: "작품/회차" },
  { id: "concept", label: "컨셉정리" },
  { id: "employees", label: "직원" },
  { id: "settings", label: "설정" },
];

type SidebarProps = {
  activeItem: NavigationItem;
  onSelect: (item: NavigationItem) => void;
};

/** 작품 관리와 회차 Viewer 등 각 화면의 진입점을 표시하고 선택을 App에 전달한다. */
function Sidebar({ activeItem, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="주 메뉴">
      {navigationItems.map((item) => (
        <button
          aria-current={activeItem === item.id ? "page" : undefined}
          className={activeItem === item.id ? "nav-item is-active" : "nav-item"}
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export default Sidebar;
