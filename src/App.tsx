import { useState } from "react";
import Header from "./components/Header";
import Sidebar, { type NavigationItem } from "./components/Sidebar";
import CompanyScreen from "./screens/CompanyScreen";
import EmployeesScreen from "./screens/EmployeesScreen";
import SettingsScreen from "./screens/SettingsScreen";
import WorksScreen from "./screens/WorksScreen";

const screens: Record<NavigationItem, React.ComponentType> = {
  company: CompanyScreen,
  works: WorksScreen,
  employees: EmployeesScreen,
  settings: SettingsScreen,
};

function App() {
  const [activeItem, setActiveItem] = useState<NavigationItem>("company");
  const ActiveScreen = screens[activeItem];

  return (
    <div className="desktop-app">
      <Header onOpenSettings={() => setActiveItem("settings")} />
      <div className="app-body">
        <Sidebar activeItem={activeItem} onSelect={setActiveItem} />
        <main className="main-content" aria-live="polite">
          <ActiveScreen />
        </main>
      </div>
    </div>
  );
}

export default App;
