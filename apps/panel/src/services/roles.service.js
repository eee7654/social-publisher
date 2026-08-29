import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetcher } from '@/lib/api-service';

export const ROLE_KEYS = {
    all: ['roles'],
    lists: () => [...ROLE_KEYS.all, 'list'],
    list: (filters) => [...ROLE_KEYS.lists(), filters],
    lookup: () => [...ROLE_KEYS.lists(), 'lookup'],
};

/**
 * هوک دریافت لیست سازمان‌ها (همراه با سرچ و صفحه‌بندی)
 * @param {Object} filters - شامل page, limit, search
 */
export const useList = (filters) => {
    return useQuery({
        queryKey: ORG_KEYS.list(filters),
        queryFn: () => fetcher({
            method: 'GET',
            url: '/api/v1/panel/roles/fetch'
        }),
        keepPreviousData: true, 
        staleTime: 5 * 60 * 1000,
    });
};


export const useLookup = () => {
    return useQuery({
        queryKey: ROLE_KEYS.lookup(),
        queryFn: () => fetcher({
            method: 'GET',
            url: '/api/v1/panel/roles/lookup',
        }),
        keepPreviousData: true, 
        staleTime: 5 * 60 * 1000,
    });
};
