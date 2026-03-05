import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { FolderOpen } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { querySearchProjects } from "@/lib/utils";
import { ProjectData } from "@/types/types";
import { toast } from "@/components/ui/use-toast";

export const Route = createFileRoute("/_authenticated/_layout/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [searchValue, setSearchValue] = useState("");
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchProjects = async (value: string) => {
    setIsLoading(true);
    try {
      const result = await querySearchProjects(value || undefined);
      setProjects(result.data?.searchProjects ?? []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error(error);
      toast({
        variant: "destructive",
        title: "Error loading projects",
        description:
          error?.errors?.[0]?.message || error?.message || "An error occurred",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchProjects("");
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchValue(value);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      fetchProjects(value);
    }, 300);
  };

  return (
    <main className="grid flex-1 items-start gap-4 p-4 sm:px-6 sm:py-0 md:gap-8">
      <Card className="sm:col-span-2">
        <CardHeader className="flex flex-row items-start bg-muted/50">
          <div className="grid gap-0.5">
            <CardTitle className="group flex items-center gap-2 text-lg">
              <FolderOpen className="h-5 w-5" />
              Projects
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          <div className="mb-4">
            <Input
              placeholder="Search projects by name..."
              value={searchValue}
              onChange={handleSearchChange}
              className="max-w-sm"
            />
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FolderOpen className="h-10 w-10 mb-2 opacity-40" />
              <p>No projects found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Team</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">
                      {project.projectName}
                    </TableCell>
                    <TableCell>{project.DepartmentNumber ?? "—"}</TableCell>
                    <TableCell>{project.Team ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
