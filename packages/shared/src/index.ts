export * from './models/incident';
export * from './models/telemetry';
export * from './models/project';
export * from './models/ws-events';
export * from './models/knowledge';

import * as _sb from './supabase';
export const createApexSupabaseClient = _sb.createApexSupabaseClient;
export const signInWithGoogle = _sb.signInWithGoogle;
export const signOutSupabase = _sb.signOutSupabase;
export const saveUserIntegration = _sb.saveUserIntegration;
export const fetchUserIntegration = _sb.fetchUserIntegration;
export const syncIncidentToSupabase = _sb.syncIncidentToSupabase;
export const fetchUserIncidentsFromSupabase = _sb.fetchUserIncidentsFromSupabase;
export const getSupabaseEnvConfig = _sb.getSupabaseEnvConfig;

export type { UserProfile, UserIntegration, User, Session, SupabaseClient } from './supabase';
