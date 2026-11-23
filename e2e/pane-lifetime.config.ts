import { defineConfig } from '@playwright/test';
import base from './workspace-asset-load.config';
export default defineConfig({...base,testMatch:'pane-lifetime.spec.ts'});
