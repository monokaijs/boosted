import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProjectAvatar } from "./project-avatar";

afterEach(cleanup);

it("renders the uppercase first character over the project gradient", () => {
  const { container } = render(<ProjectAvatar project={{ id: "alpha", name: "  boosted" }} />);
  const avatar = container.querySelector('[data-slot="project-avatar"]')!;
  expect(avatar).toHaveTextContent("B");
  expect((avatar as HTMLElement).style.backgroundImage).toContain("gradient");
  expect(avatar).toHaveAttribute("aria-hidden", "true");
});

it("falls back for a broken icon and renders a replacement", () => {
  const project = { id: "alpha", name: "alpha", icon: "data:image/png;base64,broken" };
  const { container, rerender } = render(<ProjectAvatar project={project} />);
  expect(container.querySelector("img")).toHaveAttribute("src", project.icon);
  expect(container).not.toHaveTextContent("A");
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(container).toHaveTextContent("A");
  rerender(<ProjectAvatar project={{ ...project, icon: "data:image/png;base64,replacement" }} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,replacement");
  rerender(<ProjectAvatar project={{ ...project, icon: null }} />);
  expect(container).toHaveTextContent("A");
});
