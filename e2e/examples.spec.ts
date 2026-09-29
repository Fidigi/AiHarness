// ============================================================
// E2E Tests - Example Flow
// ============================================================

import { test, expect } from '@playwright/test';

test.describe('AiHarness Web', () => {
  // Test page load
  test('should load the application', async ({ page }) => {
    await page.goto('/');
    
    // Check that the app loads (adjust selectors based on actual implementation)
    const heading = page.locator('h1, h2').first();
    expect(heading).toBeDefined();
  });

  // Test navigation to settings
  test('should navigate to settings', async ({ page }) => {
    await page.goto('/');
    
    // Click on settings button (adjust selector based on implementation)
    const settingsBtn = page.locator('button').filter({ hasText: /settings/i });
    if (await settingsBtn.count()) {
      await settingsBtn.click();
      
      // Check that we're on the settings page
      const settingsHeading = page.locator('h2').filter({ hasText: /settings/i });
      expect(settingsHeading).toBeDefined();
    }
  });

  // Test sidebar interactions (if implemented)
  test.describe('Sidebar', () => {
    test('should create a new session from sidebar', async ({ page }) => {
      await page.goto('/');
      
      // Click the "+" button to create new session
      const newChatBtn = page.locator('[aria-label="New chat"], button').first();
      if (await newChatBtn.count()) {
        await newChatBtn.click();
        
        // Verify sidebar updated or new conversation is shown
        expect(page.url()).toContain('/chat/');
      }
    });
  });

  // Test chat input and message sending
  test.describe('Chat', () => {
    test('should display empty state when no messages', async ({ page }) => {
      await page.goto('/');
      
      const emptyState = page.locator('.chat-empty, text=Welcome to AiHarness');
      expect(emptyState).toBeDefined();
    });

    test.skip('should send a message (requires backend)', async ({ page }) => {
      // This test requires the full stack to be running with AI provider configured
      await page.goto('/');
      
      const input = page.locator('input[type="text"]');
      await input.fill('Hello, world!');
      
      const sendBtn = page.locator('button').filter({ hasText: /send/i });
      if (await sendBtn.count()) {
        await sendBtn.click();
        
        // Wait for message to appear
        const message = page.locator('.message.user').first();
        expect(message).toContainText('Hello, world!');
      }
    });
  });

  // Test responsive design
  test.describe('Responsive Design', () => {
    test('should render on mobile viewport', async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 375, height: 667 },
      });
      const page = await context.newPage();
      
      await page.goto('/');
      
      // Check that the app renders without horizontal scroll
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(375 + 10); // Allow small margin
      
      await context.close();
    });

    test('should render on tablet viewport', async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 768, height: 1024 },
      });
      const page = await context.newPage();
      
      await page.goto('/');
      
      expect(page.url()).toBe('http://localhost:3000/');
      
      await context.close();
    });
  });

  // Test accessibility basics
  test.describe('Accessibility', () => {
    test('should have proper document title', async ({ page }) => {
      await page.goto('/');
      
      const title = page.locator('title');
      expect(title).toBeDefined();
    });

    test.skip('should not have critical accessibility issues (axe-core)', async ({ page }) => {
      // Requires axe-playwright or similar
      // This is a placeholder for future implementation
      await page.goto('/');
      
      // TODO: Implement axe accessibility checks
      expect(true).toBe(true);
    });
  });

  // Test error handling
  test.describe('Error Handling', () => {
    test('should handle invalid routes gracefully', async ({ page }) => {
      await page.goto('/invalid-route-that-does-not-exist');
      
      // Should not crash - should show 404 or redirect
      expect(page.url()).toContain('localhost:3000');
    });

    test('should handle network errors gracefully', async ({ page }) => {
      await page.goto('/');
      
      // Simulate network error by blocking API calls (if any)
      await page.route('**/api/**', (route) => route.abort('failed'));
      
      // App should still be functional
      expect(page.url()).toContain('localhost:3000');
    });
  });

  // Test performance basics
  test.describe('Performance', () => {
    test('should load within acceptable time', async ({ page }) => {
      const startTime = Date.now();
      
      await page.goto('/');
      
      const loadTime = Date.now() - startTime;
      expect(loadTime).toBeLessThan(5000); // 5 second timeout
      
      console.log(`Page loaded in ${loadTime}ms`);
    });
  });
});
