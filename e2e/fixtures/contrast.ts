import { expect, type Locator } from '@playwright/test';

export async function expectThemeRoles(elements: Locator, surface: string | null, text = '--text-primary'): Promise<void> {
  expect(await elements.count()).toBeGreaterThan(0);
  const values = await elements.evaluateAll((nodes, { surface, text }) => nodes.map(element => {
    const style = getComputedStyle(element);
    const probe = document.createElement('span'); document.body.append(probe);
    probe.style.color = surface ? style.getPropertyValue(surface) : 'transparent'; const background = getComputedStyle(probe).color;
    probe.style.color = style.getPropertyValue(text); const foreground = getComputedStyle(probe).color;
    probe.remove();
    return { selector: element.className || element.tagName, background: style.backgroundColor === background, foreground: style.color === foreground };
  }), { surface, text });
  for (const value of values) expect(value, String(elements)).toMatchObject({ background: true, foreground: true });
}

// These audited surfaces use opaque sRGB colors; measure the rendered state,
// walking transparent descendants to the actual painted ancestor.
export async function expectContrast(elements: Locator, property: 'color' | 'borderTopColor' | 'outlineColor' | 'accentColor' | 'boxShadow' = 'color', minimum = 4.5): Promise<void> {
  const results = await elements.evaluateAll((nodes, property) => nodes.map(node => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (values: number[]) => values.map(v => v / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index]!, 0);
    let ancestor: Element | null = node;
    let background = 'rgba(0, 0, 0, 0)';
    while (ancestor && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    const [low, high] = [luminance(rgb(getComputedStyle(node)[property])), luminance(rgb(background))].sort((a, b) => a - b);
    return { selector: node.className, ratio: (high! + .05) / (low! + .05) };
  }), property);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result.ratio, result.selector).toBeGreaterThanOrEqual(minimum);
}
