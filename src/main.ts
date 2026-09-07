import { mount } from "svelte";
import App from "./ui/App.svelte";
import "./ui/theme.css";
import { startMeterLoop } from "./state/store";

const target = document.getElementById("app");
if (!target) throw new Error("#app mount point missing");

const app = mount(App, { target });
startMeterLoop();

export default app;
