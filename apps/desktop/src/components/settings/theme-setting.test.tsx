import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThemeSetting } from "./theme-setting";

describe("ThemeSetting", () => {
  it("reflects and changes the stored theme", async () => {
    const user = userEvent.setup();
    render(<ThemeSetting />);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("clawde.theme")).toBe("light");
  });
});
