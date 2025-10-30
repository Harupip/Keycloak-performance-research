-- ========================================
-- Initialize JGroups JDBC_PING table
-- ========================================

-- This table is used by Keycloak for cluster discovery
-- via JDBC_PING protocol

-- Check if table exists, if not create it
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'jgroupsping') THEN
        CREATE TABLE JGROUPSPING (
            own_addr VARCHAR(200) NOT NULL,
            cluster_name VARCHAR(200) NOT NULL,
            ping_data BYTEA,
            constraint PK_JGROUPSPING PRIMARY KEY (own_addr, cluster_name)
        );
        
        RAISE NOTICE 'Table JGROUPSPING created successfully';
    ELSE
        RAISE NOTICE 'Table JGROUPSPING already exists';
    END IF;
END $$;

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE JGROUPSPING TO keycloak;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_jgroupsping_cluster ON JGROUPSPING(cluster_name);

-- Verify table creation
SELECT 'JGroups JDBC_PING table initialized' as status;