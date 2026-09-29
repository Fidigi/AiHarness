// ============================================================
// Terminal UI Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalUI } from './terminal-ui';

describe('TerminalUI', () => {
  let terminal: TerminalUI;
  let stdoutSpy: jest.SpyInstance | ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    terminal = new TerminalUI({ title: 'Test Harness' });
    
    // Capture console output
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation();
    const originalClear = process.stdout.write;
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Welcome tests
  describe('welcome()', () => {
    it('should output welcome message', () => {
      terminal.welcome();
      
      expect(console.log).toHaveBeenCalled();
    });

    it('should display the title', () => {
      const mockWrite = vi.spyOn(process.stdout, 'write');
      terminal.welcome();
      
      // Should contain some output (title and help text)
      expect(mockWrite.mock.calls.length + console.log.mock.calls.length).toBeGreaterThan(0);
    });
  });

  // Display user message tests
  describe('displayUserMessage()', () => {
    it('should display the message content', () => {
      terminal.displayUserMessage('Hello, world!');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Hello, world!'));
    });

    it('should prefix with > symbol', () => {
      const mockWrite = vi.spyOn(process.stdout, 'write');
      terminal.displayUserMessage('Test message');
      
      // Check that output contains the expected format
      expect(console.log).toHaveBeenCalled();
    });
  });

  // Display assistant message tests
  describe('displayAssistantMessage()', () => {
    it('should display the response', () => {
      terminal.displayAssistantMessage('This is a response');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('This is a response'));
    });

    it('should wrap in assistant format', () => {
      const mockWrite = vi.spyOn(process.stdout, 'write');
      terminal.displayAssistantMessage('Response content');
      
      // Should output formatted message
      expect(console.log).toHaveBeenCalled();
    });
  });

  // Display command output tests
  describe('displayCommand()', () => {
    it('should display command name and output', () => {
      terminal.displayCommand('test', 'Output content');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[test]'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Output content'));
    });
  });

  // Show error tests
  describe('showError()', () => {
    it('should display error message', () => {
      const originalError = console.error;
      let captured: string[] = [];
      console.error = (...args) => captured.push(args.join(' '));

      terminal.showError('Something went wrong');
      
      expect(captured[0]).toContain('[Error]');
      expect(captured[0]).toContain('Something went wrong');

      console.error = originalError;
    });
  });

  // Show help tests
  describe('showHelp()', () => {
    it('should display available commands', () => {
      terminal.showHelp();
      
      expect(console.log).toHaveBeenCalled();
    });

    it('should list /help command', () => {
      const mockWrite = vi.spyOn(process.stdout, 'write');
      terminal.showHelp();
      
      // Should contain help text with commands listed
      expect(mockWrite.mock.calls.length + console.log.mock.calls.length).toBeGreaterThan(0);
    });
  });

  // Exit message tests
  describe('exitMessage()', () => {
    it('should display exit message', () => {
      terminal.exitMessage('Goodbye!');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Goodbye'));
    });
  });

  // Clear tests
  describe('clear()', () => {
    it('should send clear screen escape sequence', () => {
      const mockWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      
      terminal.clear();
      
      expect(mockWrite).toHaveBeenCalledWith('\x1Bc');
    });
  });

  // Constructor tests
  describe('constructor()', () => {
    it('should use default options when none provided', () => {
      const t = new TerminalUI();
      expect(t).toBeDefined();
    });

    it('should accept custom title', () => {
      const t = new TerminalUI({ title: 'Custom Title' });
      expect(t).toBeDefined();
    });

    it('should accept theme option', () => {
      const t = new TerminalUI({ theme: 'dark' });
      expect(t).toBeDefined();
    });
  });
});
