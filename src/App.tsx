import { useCallback, useRef, useState } from "react";
import Header from "./components/Header";
import Sidebar, { type NavigationItem } from "./components/Sidebar";
import CompanyScreen from "./screens/CompanyScreen";
import ConceptScreen from "./screens/ConceptScreen";
import EmployeesScreen from "./screens/EmployeesScreen";
import SettingsScreen from "./screens/SettingsScreen";
import WorksScreen from "./screens/WorksScreen";
import WorkManagementScreen from "./screens/WorkManagementScreen";

const screens: Record<NavigationItem, React.ComponentType> = {
  company: CompanyScreen,
  works: WorksScreen,
  workManagement: WorkManagementScreen,
  concept: ConceptScreen,
  employees: EmployeesScreen,
  settings: SettingsScreen,
};

/** 주 화면을 전환하며 작품/Canon/회차 편집 입력과 진행 중 요청을 보호한다. */
function App() {
  const [activeItem, setActiveItem] = useState<NavigationItem>("company");
  const ActiveScreen = screens[activeItem];
  const editorNavigation = useRef({ dirty: false, busy: false });
  /** 현재 작품/Canon/회차 화면의 편집 상태를 기존 이동 확인에 사용할 수 있도록 보관한다. */
  const handleEditorNavigationState = useCallback((dirty: boolean, busy: boolean) => { editorNavigation.current = { dirty, busy }; }, []);
  /** 편집 화면 이탈 전에 미저장 입력 폐기를 확인하며 저장 중에는 이동을 막는다. */
  function handleNavigate(item: NavigationItem) {
    if (item === activeItem) return;
    if ((activeItem === "concept" || activeItem === "workManagement" || activeItem === "works") && (editorNavigation.current.busy || (editorNavigation.current.dirty && !window.confirm("저장하지 않은 변경사항이 있습니다.\n변경 내용을 버리고 이동하시겠습니까?")))) return;
    editorNavigation.current = { dirty: false, busy: false };
    setActiveItem(item);
  }

  return (
    <div className="desktop-app">
      <Header onOpenSettings={() => handleNavigate("settings")} />
      <div className="app-body">
        <Sidebar activeItem={activeItem} onSelect={handleNavigate} />
        <main className="main-content" aria-live="polite">
          {activeItem === "concept" ? <ConceptScreen onNavigationState={handleEditorNavigationState} />
            : activeItem === "workManagement" ? <WorkManagementScreen onNavigationState={handleEditorNavigationState} />
              : activeItem === "works" ? <WorksScreen onNavigationState={handleEditorNavigationState} />
              : <ActiveScreen />}
        </main>
      </div>
    </div>
  );
}

export default App;
