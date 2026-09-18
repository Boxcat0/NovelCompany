export type NavigationItem = "company" | "works" | "employees" | "settings";

const navigationItems: Array<{ id: NavigationItem; label: string }> = [
  { id: "company", label: "회사" },
  { id: "works", label: "작품" },
  { id: "employees", label: "직원" },
  { id: "settings", label: "설정" },
];

type SidebarProps = {
  activeItem: NavigationItem;
  onSelect: (item: NavigationItem) => void;
};

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
