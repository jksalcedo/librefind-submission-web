// TypeScript type definitions for the LibreFind submission web application

// User type definition
interface User {
    id: string;
    email: string;
    isActive: boolean;
}

// Submission type definition
interface Submission {
    id: string;
    userId: string;
    appName: string;
    appPackage: string;
    description: string;
    repoUrl: string;
    license: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    createdAt: Date;
}

// Target type definition
interface Target {
    name: string;
    packageName: string;
}

// Solution type definition
interface Solution {
    name: string;
    packageName: string;
}

// Impact statistics type definition
interface ImpactStats {
    totalAudited: number;
    sovereign: number;
    transitioning: number;
    captured: number;
}

// Function type definitions
declare function login(email: string, password: string): Promise<User>;
declare function logout(): Promise<void>;
declare function submitApp(submission: Submission): Promise<void>;
declare function fetchImpactStats(): Promise<ImpactStats>;