import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://cmxaxtwakcoicjkupocc.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNteGF4dHdha2NvaWNqa3Vwb2NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MzM1NTksImV4cCI6MjEwMzAwOTU1OX0.5cPUKbM5M0H9CdIuMM3QEYPycmLlyx3u1YX14YNi0hs'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)